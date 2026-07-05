import express, { Request, Response } from "express";
import { Conversation } from "@mtcute/node";
import {
  getClientByPhone,
  clearSession,
  generateRandomUsername,
  handleTelegramRateLimit,
  sendLoginCode,
  verifyLoginCode,
  withAccountLock,
} from "./telegram/manager";
import { supabase, protectedDb } from "./db/supabase";
import { broadcastLog } from "./broadcast";
import { getWorkspace } from "./workspace";
import { generateBotUsernames, botDisplayName } from "./ai/groq";
import { createBotViaBotFather } from "./telegram/botfather";

// Only channels created by accounts in THIS workspace get recorded into the
// sister project's protected_channels table (so its auto-leave bot skips them).
// Friends' channels are never recorded. Override via env if the name changes.
const PROTECTED_CHANNELS_WORKSPACE =
  process.env.PROTECTED_CHANNELS_WORKSPACE || "me";

// Queue processor
let isProcessingQueue = false;

const router = express.Router();

// Placeholder root route
router.get("/", (_req: Request, res: Response) => {
  res.json({ message: "API is working" });
});

// Set all accounts available now
router.post(
  "/accounts/set-all-available",
  async (req: Request, res: Response) => {
    try {
      const ws = getWorkspace(req);
      const now = new Date().toISOString();
      // Clear both block sources: expire the 24h window (next_available_time in
      // the past forces a counter reset) and drop any active flood wait. Match
      // rows blocked by either column, scoped to the caller's workspace.
      const { data, error } = await supabase
        .from("telegram_accounts")
        .update({ next_available_time: now, flood_wait_until: null })
        .eq("workspace", ws)
        .or("next_available_time.not.is.null,flood_wait_until.not.is.null");

      if (error) throw error;
      res.json({ success: true, message: "Updated all accounts availability" });
    } catch (error) {
      res.status(500).json({ error: "Failed to update accounts availability" });
    }
  }
);

// Queue routes
router.post("/queue/add", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { phone, group_count, naming_pattern, description, messages, type } =
      req.body;

    const jobType =
      type === "channel" ? "channel" : type === "bot" ? "bot" : "group";

    if (!phone || !group_count || !naming_pattern) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: phone, group_count, naming_pattern",
      });
    }

    // Bots cap at 20 per account (Telegram limit); groups/channels at 50.
    const maxCount = jobType === "bot" ? 20 : 50;
    const count = Number(group_count);
    if (!count || count < 1 || count > maxCount) {
      return res.status(400).json({
        success: false,
        error: `group_count must be between 1 and ${maxCount}`,
      });
    }

    // Validate phone exists AND belongs to the caller's workspace, so one user
    // can't queue jobs against another user's account.
    const { data: account, error: accountError } = await supabase
      .from("telegram_accounts")
      .select("phone")
      .eq("phone", phone)
      .eq("workspace", ws)
      .single();

    if (accountError || !account) {
      return res.status(404).json({
        success: false,
        error: "Account not found",
      });
    }

    // Base row shared by both group and channel jobs.
    const baseRow = {
      phone,
      workspace: ws,
      group_count: count,
      naming_pattern,
      description: description || "",
      messages: messages || [],
      status: "pending",
      created_at: new Date().toISOString(),
    };

    // Add job to queue (with the newer `type` column).
    let { data: job, error: jobError } = await supabase
      .from("group_creation_queue")
      .insert({ ...baseRow, type: jobType })
      .select()
      .single();

    // If the `type` column doesn't exist yet (DB not migrated), Supabase returns
    // a schema-cache error. Groups don't need the column, so retry without it and
    // keep working; channels genuinely require the migration, so surface a clear
    // one-line fix instead of a cryptic error.
    const columnMissing =
      jobError &&
      /type/i.test(jobError.message) &&
      /(column|schema cache|does not exist)/i.test(jobError.message);

    if (columnMissing) {
      if (jobType === "channel") {
        return res.status(500).json({
          success: false,
          error:
            "The database is missing the 'type' column required for channels. " +
            "Run this once in Supabase SQL editor: " +
            "ALTER TABLE group_creation_queue ADD COLUMN type text NOT NULL DEFAULT 'group';",
        });
      }
      ({ data: job, error: jobError } = await supabase
        .from("group_creation_queue")
        .insert(baseRow)
        .select()
        .single());
    }

    if (jobError) {
      return res.status(500).json({
        success: false,
        error: `Failed to add job to queue: ${jobError.message}`,
      });
    }

    // Start processing queue if not already running
    processNextQueueJob();

    return res.json({
      success: true,
      message: "Job added to queue",
      job_id: job.id,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  }
});

router.get("/queue", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { data: jobs, error } = await supabase
      .from("group_creation_queue")
      .select("*")
      .eq("workspace", ws)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        error: `Failed to get queue: ${error.message}`,
      });
    }

    return res.json({
      success: true,
      jobs,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  }
});

router.delete("/queue/:id", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { id } = req.params;

    const { error } = await supabase
      .from("group_creation_queue")
      .delete()
      .eq("id", id)
      .eq("workspace", ws);

    if (error) {
      return res.status(500).json({
        success: false,
        error: `Failed to delete job: ${error.message}`,
      });
    }

    return res.json({
      success: true,
      message: `Job ${id} deleted from queue`,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || "Unknown error",
    });
  }
});

// Process the next job in the queue
async function processNextQueueJob() {
  if (isProcessingQueue) return;

  try {
    isProcessingQueue = true;

    // Get the next pending job
    const { data: job, error } = await supabase
      .from("group_creation_queue")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (error || !job) {
      isProcessingQueue = false;
      return;
    }

    // Mark job as started
    await supabase
      .from("group_creation_queue")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", job.id);

    const isBotJob = job.type === "bot";
    const jobType: "group" | "channel" =
      job.type === "channel" ? "channel" : "group";
    const jobLabel = isBotJob ? "bot" : jobType;

    broadcastLog({
      message: `Starting queued job #${job.id} for account ${job.phone} to create ${job.group_count} ${jobLabel}s`,
      type: "info",
      timestamp: new Date().toISOString(),
    });

    try {
      let completedMsg: string;

      if (isBotJob) {
        // Bot jobs store the pattern choice in naming_pattern ('default'|'custom')
        // and the theme in description.
        const botResult = await createBots(
          job.phone,
          job.group_count,
          job.naming_pattern === "custom",
          job.description || undefined,
          job.workspace || "default"
        );
        completedMsg = `Completed queued job #${job.id} for account ${job.phone} — created ${botResult.botsCreated}/${botResult.totalBots} bots`;
      } else {
        const result = await createGroups(
          job.phone,
          job.group_count,
          job.naming_pattern,
          job.description,
          job.messages,
          jobType,
          job.workspace || "default"
        );
        completedMsg = `Completed queued job #${job.id} for account ${job.phone} — created ${result.successfulGroups}/${result.totalGroups} ${jobType}s`;
      }

      await supabase
        .from("group_creation_queue")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      broadcastLog({
        message: completedMsg,
        type: "success",
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      await supabase
        .from("group_creation_queue")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: err.message || "Unknown error",
        })
        .eq("id", job.id);

      broadcastLog({
        message: `Failed queued job #${job.id} for account ${job.phone}: ${
          err.message || "Unknown error"
        }`,
        type: "error",
        timestamp: new Date().toISOString(),
      });
    }

    // Process next job if available
    isProcessingQueue = false;
    processNextQueueJob();
  } catch (err: any) {
    isProcessingQueue = false;
    broadcastLog({
      message: `Error in queue processor: ${err.message || "Unknown error"}`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
  }
}

// Export function to start queue processor
export function startQueueProcessor() {
  broadcastLog({
    message: "Starting queue processor...",
    type: "info",
    timestamp: new Date().toISOString(),
  });
  processNextQueueJob();
}

interface CreateGroupsResult {
  success: boolean;
  totalGroups: number;
  successfulGroups: number;
  results: any[];
}

// Single source of truth for group/channel creation logic
async function createGroups(
  phone: string,
  groupCount: number,
  namingPattern: string,
  description?: string,
  messages?: any[],
  type: "group" | "channel" = "group",
  workspace: string = "default"
): Promise<CreateGroupsResult> {
  // Serialize: only one account may be active at a time.
  return withAccountLock(() =>
    createGroupsInner(
      phone,
      groupCount,
      namingPattern,
      description,
      messages,
      type,
      workspace
    )
  );
}

async function createGroupsInner(
  phone: string,
  groupCount: number,
  namingPattern: string,
  description?: string,
  messages?: any[],
  type: "group" | "channel" = "group",
  workspace: string = "default"
): Promise<CreateGroupsResult> {
  const entity = type === "channel" ? "channel" : "group";
  let client: any = null;

  try {
    // Check rate limit first
    const { data: limitCheck, error: limitError } = await supabase.rpc(
      "check_rate_limit",
      { account_phone: phone }
    );

    if (limitError) {
      throw new Error(`Rate limit check error: ${limitError.message}`);
    }

    if (!limitCheck) {
      throw new Error(`Account not found: ${phone}`);
    }

    if (limitCheck.error) {
      throw new Error(limitCheck.error);
    }

    if (!limitCheck.can_create) {
      throw new Error(limitCheck.error || "Account is currently rate limited.");
    }

    // Get current groups count from database
    const { data: accountData, error: accountError } = await supabase
      .from("telegram_accounts")
      .select("groups_count")
      .eq("phone", phone)
      .single();

    if (accountError || !accountData) {
      throw new Error("Failed to get account groups count");
    }

    const currentGroupsCount = accountData.groups_count || 0;

    // Restore Telegram client
    client = await getClientByPhone(phone);

    // Safety check: verify client is still valid
    try {
      await client.getMe();
    } catch (clientErr) {
      broadcastLog({
        message: `Client validation failed for ${phone}, recreating session...`,
        type: "error",
        timestamp: new Date().toISOString(),
      });
      await clearSession(phone);
      client = await getClientByPhone(phone);
    }

    const results = [];
    let successfulGroups = 0;

    broadcastLog({
      message: `Starting creation of ${groupCount} ${entity}s for account ${phone}`,
      type: "info",
      timestamp: new Date().toISOString(),
    });

    broadcastLog({
      message: `Account ${phone} status: ${limitCheck.groups_created_24h}/50 groups today, can_create: ${limitCheck.can_create}, total groups: ${limitCheck.total_groups}`,
      type: "info",
      timestamp: new Date().toISOString(),
    });

    for (let i = 1; i <= groupCount; i++) {
      const groupNumber = currentGroupsCount + i;
      const randomUsername = generateRandomUsername();
      const title = namingPattern
        .replace("{n}", groupNumber.toString())
        .replace("{username}", randomUsername);

      let groupResult: any = { success: false, title };

      try {
        const chat = await createSingleGroup(client, title, description, type);
        if (chat && chat.id) {
          groupResult.success = true;
          groupResult.id = chat.id;
          successfulGroups++;

          broadcastLog({
            message: `Created ${entity} ${title} for account ${phone}`,
            type: "success",
            timestamp: new Date().toISOString(),
          });

          // Protect broadcast channels from the external auto-leave bot, but
          // ONLY for my own workspace — friends' channels aren't recorded into
          // the sister project. (Megagroups are already skipped by the bot's
          // megagroup !== true filter.)
          if (type === "channel" && workspace === PROTECTED_CHANNELS_WORKSPACE) {
            await recordProtectedChannel(phone, chat.id, title);
          }

          const msgError = await sendMessagesToGroup(
            client,
            chat.id,
            title,
            phone,
            messages
          );
          if (msgError) {
            groupResult.messageError = msgError;
          }
        } else {
          broadcastLog({
            message: `Failed to create ${entity} ${title} for account ${phone}`,
            type: "error",
            timestamp: new Date().toISOString(),
          });
          groupResult.error = "Failed to get chat info";
        }
      } catch (err: any) {
        // Check if this is a flood wait error
        const isFloodWait =
          err.message &&
          (err.message.includes("flood wait") ||
            err.message.includes("FLOOD_WAIT") ||
            err.message.includes("wait of"));

        if (isFloodWait) {
          const waitMatch = err.message.match(/wait of (\d+) seconds/i);
          const waitSeconds = waitMatch ? parseInt(waitMatch[1]) : 0;

          // For very long flood waits (>1 hour), mark account unavailable and stop
          if (waitSeconds > 3600) {
            const hours = Math.round(waitSeconds / 3600);
            broadcastLog({
              message: `Telegram flood wait detected: ${waitSeconds} seconds (${hours} hours). Marking account as unavailable and skipping...`,
              type: "error",
              timestamp: new Date().toISOString(),
            });

            broadcastLog({
              message: `Account ${phone} had ${limitCheck.groups_created_24h} groups created today. Telegram's anti-spam may trigger before 50 groups due to creation speed, message patterns, or account trust level.`,
              type: "info",
              timestamp: new Date().toISOString(),
            });

            await handleTelegramRateLimit(phone, err);
            break;
          }

          // Shorter flood wait — wait and retry once
          broadcastLog({
            message: `Telegram flood wait detected: ${waitSeconds} seconds. Waiting and retrying...`,
            type: "error",
            timestamp: new Date().toISOString(),
          });

          const waitTime = Math.max(waitSeconds * 1000 + 2000, 10000);
          await new Promise((resolve) => setTimeout(resolve, waitTime));

          // Retry the group creation after waiting
          try {
            const chat = await createSingleGroup(
              client,
              title,
              description,
              type
            );
            if (chat && chat.id) {
              groupResult.success = true;
              groupResult.id = chat.id;
              successfulGroups++;

              broadcastLog({
                message: `Successfully created ${entity} ${title} after flood wait retry`,
                type: "success",
                timestamp: new Date().toISOString(),
              });

              const msgError = await sendMessagesToGroup(
                client,
                chat.id,
                title,
                phone,
                messages
              );
              if (msgError) {
                groupResult.messageError = msgError;
              }
            } else {
              broadcastLog({
                message: `Failed to create ${entity} ${title} after flood wait retry`,
                type: "error",
                timestamp: new Date().toISOString(),
              });
              groupResult.error = "Failed to get chat info after retry";
            }
          } catch (retryErr: any) {
            const retryWait = await handleTelegramRateLimit(phone, retryErr);
            if (retryWait !== null) {
              broadcastLog({
                message: `Telegram rate limit after retry: A wait of ${retryWait} seconds is required`,
                type: "error",
                timestamp: new Date().toISOString(),
              });
              break;
            }

            broadcastLog({
              message: `Error creating group after retry: ${retryErr.message}`,
              type: "error",
              timestamp: new Date().toISOString(),
            });
            groupResult.error = retryErr.message;
          }
        } else {
          // Non-flood-wait error
          const waitSeconds = await handleTelegramRateLimit(phone, err);
          if (waitSeconds !== null) {
            broadcastLog({
              message: `Telegram rate limit: A wait of ${waitSeconds} seconds is required`,
              type: "error",
              timestamp: new Date().toISOString(),
            });
            break;
          }

          broadcastLog({
            message: `Error creating group: ${err.message}`,
            type: "error",
            timestamp: new Date().toISOString(),
          });
          groupResult.error = err.message;
        }
      }

      results.push(groupResult);

      // Delay between groups (skip delay after last group or after a rate limit break)
      if (i < groupCount) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    // Update groups count in database
    if (successfulGroups > 0) {
      await supabase.rpc("increment_groups_count", {
        phone_number: phone,
        increment_amount: successfulGroups,
      });

      // Track channels separately (subset of groups_count) so the UI can show a
      // groups/channels breakdown. groups_count stays the combined total.
      if (type === "channel") {
        await supabase.rpc("increment_channels_count", {
          phone_number: phone,
          increment_amount: successfulGroups,
        });
      }

      await supabase.rpc("update_rate_limit_status", {
        account_phone: phone,
        groups_created: successfulGroups,
      });
    }

    return {
      success: true,
      totalGroups: groupCount,
      successfulGroups,
      results,
    };
  } catch (err: any) {
    throw err;
  } finally {
    // Always clean up the session
    if (client) {
      try {
        await clearSession(phone);
      } catch (cleanupErr) {
        console.error("Error during session cleanup:", cleanupErr);
      }
    }
  }
}

interface CreateBotsResult {
  success: boolean;
  totalBots: number;
  botsCreated: number;
}

// Create `botCount` bots for one account via @BotFather, one at a time.
// Serialized behind the same account lock as group creation so only one account
// is ever active at once.
async function createBots(
  phone: string,
  botCount: number,
  useCustomPattern: boolean,
  theme: string | undefined,
  workspace: string
): Promise<CreateBotsResult> {
  return withAccountLock(() =>
    createBotsInner(phone, botCount, useCustomPattern, theme, workspace)
  );
}

async function createBotsInner(
  phone: string,
  botCount: number,
  useCustomPattern: boolean,
  theme: string | undefined,
  workspace: string
): Promise<CreateBotsResult> {
  let client: any = null;
  const usernameTheme = useCustomPattern ? theme : undefined;

  // Compact logger used throughout the bot flow (broadcasts to the live console).
  const log = (message: string, type: "info" | "success" | "error" = "info") =>
    broadcastLog({ message, type, timestamp: new Date().toISOString() });

  try {
    client = await getClientByPhone(phone);

    // Verify the restored session is still usable; recreate once if not.
    try {
      const me = await client.getMe();
      log(
        `Account ${phone} online as @${me?.username ?? me?.firstName ?? "unknown"} (id ${me?.id}).`
      );
    } catch (meErr: any) {
      log(
        `Client validation failed for ${phone} (${meErr?.message || meErr}), recreating session...`,
        "error"
      );
      await clearSession(phone);
      client = await getClientByPhone(phone);
    }

    // CRITICAL: sessions restored from a session string do NOT auto-start the
    // updates loop (that only happens on a fresh sign-in). Without it, BotFather's
    // replies never reach `waitForResponse` and every step times out. Start it
    // explicitly here — it's idempotent, and clearSession() tears it down after.
    try {
      await client.startUpdatesLoop();
      log(`Updates loop active for ${phone} (required to receive BotFather replies).`);
    } catch (loopErr: any) {
      log(
        `WARNING: could not start updates loop for ${phone}: ${loopErr?.message || loopErr}. ` +
          `BotFather replies may not be received.`,
        "error"
      );
    }

    log(
      `Starting creation of ${botCount} bots for account ${phone} ` +
        `(${useCustomPattern ? `custom theme: "${theme}"` : "default pattern"}).`
    );

    // Generate a small batch of candidate usernames up front (one AI call).
    let pool = await generateBotUsernames({ count: botCount, theme: usernameTheme });
    log(
      `Generated ${pool.length} candidate username(s): ${pool.slice(0, 10).join(", ")}${
        pool.length > 10 ? " …" : ""
      }`
    );
    if (pool.length === 0) {
      log(`No usernames generated for ${phone} (check GROQ_API_KEY / Groq status).`, "error");
    }
    const triedAll: string[] = []; // every handle attempted, to avoid on refills

    let created = 0;
    let attempts = 0;
    const maxAttempts = botCount + 8; // safety valve against runaway loops

    while (created < botCount && attempts < maxAttempts) {
      attempts++;

      // Refill from the AI if we've exhausted the current pool.
      if (pool.length === 0) {
        pool = await generateBotUsernames({
          count: botCount - created,
          theme: usernameTheme,
          avoid: triedAll,
        });
        if (pool.length === 0) {
          broadcastLog({
            message: `Could not generate any new usernames for ${phone}; stopping.`,
            type: "error",
            timestamp: new Date().toISOString(),
          });
          break;
        }
      }

      // Feed BotFather one primary handle plus a few spares so a single /newbot
      // cycle can absorb "username taken" collisions without extra AI calls.
      const primary = pool.shift() as string;
      const spares = pool.slice(0, 4);
      const candidates = [primary, ...spares];

      log(
        `Attempt ${attempts}: creating bot "${botDisplayName(primary)}" — trying @${candidates.join(
          ", @"
        )}`
      );

      const result = await createBotViaBotFather(
        client,
        botDisplayName(primary),
        candidates,
        log
      );

      // Drop everything BotFather tried from the pool and remember it.
      for (const t of result.tried) {
        triedAll.push(t);
        const idx = pool.indexOf(t);
        if (idx !== -1) pool.splice(idx, 1);
      }

      if (result.ok) {
        // BotFather is asked for the display name up front (from the primary
        // candidate) before a username is chosen, so store that exact name.
        await supabase.from("telegram_bots").insert({
          workspace,
          owner_phone: phone,
          username: result.username,
          display_name: botDisplayName(primary),
          token: result.token,
          theme: useCustomPattern ? theme || null : null,
        });
        await supabase.rpc("increment_bots_count", {
          phone_number: phone,
          increment_amount: 1,
        });
        created++;

        // Log the handle only — never the raw token (the WS log is global).
        broadcastLog({
          message: `Created bot @${result.username} for account ${phone} (${created}/${botCount})`,
          type: "success",
          timestamp: new Date().toISOString(),
        });
      } else if (result.reason === "limit") {
        // Account already at Telegram's 20-bot cap (possibly from earlier bots).
        // Force the counter to the cap so the UI reflects it and we skip ahead.
        broadcastLog({
          message: `Account ${phone} has reached Telegram's 20-bot limit. Marking as full and skipping.`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
        await supabase.rpc("set_bots_count", {
          phone_number: phone,
          new_count: 20,
        });
        break;
      } else if (result.reason === "flood") {
        log(
          `BotFather rate-limited account ${phone} (${result.message}). Stopping this account.`,
          "error"
        );
        break;
      } else if (result.reason === "timeout") {
        // Updates never arrived — retrying more usernames won't help this run.
        log(
          `BotFather did not respond for ${phone} (timeout). Stopping this account. ` +
            `If this persists, the updates loop isn't delivering messages.`,
          "error"
        );
        break;
      } else if (result.reason === "error") {
        log(`BotFather error for ${phone}: ${result.message}. Stopping this account.`, "error");
        break;
      } else {
        // no_username: all candidates in this cycle were rejected — loop will
        // refill and try fresh names on the next iteration.
        log(`No available username found this round for ${phone}; retrying with new names.`);
      }

      // Human-like gap between bots.
      if (created < botCount) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }

    return { success: true, totalBots: botCount, botsCreated: created };
  } finally {
    if (client) {
      try {
        await clearSession(phone);
      } catch (cleanupErr) {
        console.error("Error during bot session cleanup:", cleanupErr);
      }
    }
  }
}

// Helper: create a single Telegram group/channel
async function createSingleGroup(
  client: any,
  title: string,
  description?: string,
  type: "group" | "channel" = "group"
): Promise<any> {
  const isChannel = type === "channel";
  const updates = await client.call({
    _: "channels.createChannel",
    title,
    about: description || "",
    // A "group" is a megagroup (supergroup); a "channel" is a broadcast channel.
    megagroup: !isChannel,
    broadcast: isChannel,
  });

  if (
    updates &&
    typeof updates === "object" &&
    "chats" in updates &&
    Array.isArray((updates as any).chats)
  ) {
    const chatsArr = (updates as any).chats;
    if (chatsArr.length > 0) return chatsArr[chatsArr.length - 1];
  }
  return null;
}

// Record a channel we created into the external auto-leave bot's Supabase so it
// never leaves it. `channelId` is the BARE Telegram channel id (matches GramJS
// entity.id on the bot side). Best-effort: failures are logged, never thrown.
async function recordProtectedChannel(
  phone: string,
  channelId: any,
  title: string
): Promise<void> {
  if (!protectedDb) return; // Not configured — skip silently.
  try {
    // Never let a slow/hanging external DB stall channel creation or the queue:
    // supabase-js has no built-in timeout, so cap the write ourselves.
    const upsert = protectedDb
      .from("protected_channels")
      .upsert(
        { channel_id: String(channelId), phone, title },
        { onConflict: "channel_id" }
      );
    const timeout = new Promise<{ error: { message: string } }>((resolve) =>
      setTimeout(
        () => resolve({ error: { message: "timed out after 10s" } }),
        10000
      )
    );
    const { error } = await Promise.race([upsert, timeout]);
    if (error) {
      broadcastLog({
        message: `Could not record protected channel ${title}: ${error.message}`,
        type: "error",
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    broadcastLog({
      message: `Could not record protected channel ${title}: ${
        err?.message || "Unknown error"
      }`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
  }
}

// Helper: send messages to a newly created group, returns error string or null
async function sendMessagesToGroup(
  client: any,
  chatId: number,
  title: string,
  phone: string,
  messages?: any[]
): Promise<string | null> {
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  broadcastLog({
    message: `Sending messages to group ${title}...`,
    type: "info",
    timestamp: new Date().toISOString(),
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    await client.getMe();
  } catch {
    return "Client is no longer valid for sending messages";
  }

  try {
    const conv = new Conversation(client, chatId);
    await conv.with(async () => {
      for (let m = 0; m < messages.length; m++) {
        const msg = messages[m];
        if (typeof msg === "string" && msg.trim().length > 0) {
          await conv.sendText(msg);
          if (m < messages.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    });

    broadcastLog({
      message: `All messages sent to group ${title}.`,
      type: "success",
      timestamp: new Date().toISOString(),
    });
    return null;
  } catch (err) {
    const errorMsg = `Failed to send messages: ${
      err instanceof Error ? err.message : String(err)
    }`;
    broadcastLog({
      message: `Failed to send messages to group ${title}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
    return errorMsg;
  }
}

// GET /accounts - Get all accounts
router.get("/accounts", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { data, error } = await supabase
      .from("telegram_accounts")
      .select(
        "phone, username, groups_count, channels_count, groups_created_24h, next_available_time, flood_wait_until"
      )
      .eq("workspace", ws)
      .order("phone", { ascending: true });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: "Failed to fetch accounts" });
    }

    // For each account, call check_rate_limit and merge the result
    const accounts = data
      ? await Promise.all(
          data.map(async (account) => {
            const { data: rateLimitInfo, error: rateLimitError } =
              await supabase.rpc("check_rate_limit", {
                account_phone: account.phone,
              });
            // Surface whichever block is actually active so the client
            // countdown reflects a real flood wait, not just the window marker.
            const effectiveAvailableTime =
              account.flood_wait_until ?? account.next_available_time;
            if (rateLimitError) {
              console.error("Rate limit check error:", rateLimitError);
              return {
                phone: account.phone,
                username: account.username,
                groups_count: account.groups_count || 0,
                channels_count: account.channels_count || 0,
                groups_created_24h: account.groups_created_24h || 0,
                next_available_time: effectiveAvailableTime,
                rateLimitInfo: null,
              };
            }
            return {
              phone: account.phone,
              username: account.username,
              groups_count: account.groups_count || 0,
              channels_count: account.channels_count || 0,
              groups_created_24h:
                (rateLimitInfo.groups_created_24h ??
                  account.groups_created_24h) ||
                0,
              next_available_time: effectiveAvailableTime,
              can_create: rateLimitInfo.can_create,
              wait_seconds: rateLimitInfo.wait_seconds,
              total_groups: rateLimitInfo.total_groups,
              error: rateLimitInfo.error || null,
            };
          })
        )
      : [];

    res.json({ success: true, data: accounts });
  } catch (err: any) {
    console.error("Error in /accounts endpoint:", err);
    res.status(500).json({ error: err.message || "Failed to fetch accounts" });
  }
});

// DELETE /accounts/:phone - Delete an account
router.delete("/accounts/:phone", async (req: Request, res: Response) => {
  const ws = getWorkspace(req);
  const { phone } = req.params;
  if (!phone) {
    return res.status(400).json({ error: "Missing phone parameter" });
  }

  try {
    const { error } = await supabase
      .from("telegram_accounts")
      .delete()
      .eq("phone", phone)
      .eq("workspace", ws);

    if (error) {
      return res.status(500).json({ error: "Failed to delete account" });
    }

    res.json({ success: true, message: "Account deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to delete account" });
  }
});

// POST /login/send-code
router.post("/login/send-code", async (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ error: "Missing or invalid phone" });
  }
  try {
    await sendLoginCode(phone);
    res.json({ success: true, message: "Code sent" });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to send code" });
  }
});

// POST /login/verify
router.post("/login/verify", async (req: Request, res: Response) => {
  const ws = getWorkspace(req);
  const { phone, code, password } = req.body;
  if (
    !phone ||
    typeof phone !== "string" ||
    !code ||
    typeof code !== "string"
  ) {
    return res.status(400).json({ error: "Missing or invalid phone/code" });
  }
  try {
    const user = await verifyLoginCode(phone, code, password, ws);
    res.json({ success: true, user });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to verify code" });
  }
});

// POST /groups/create
router.post("/groups/create", async (req: Request, res: Response) => {
  const {
    phone,
    groupCount,
    namingPattern,
    useCustomPattern,
    description,
    messages,
    type,
  } = req.body;

  const entityType = type === "channel" ? "channel" : "group";
  const ws = getWorkspace(req);

  // Validate input
  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ error: "Missing or invalid phone" });
  }
  const count = Number(groupCount);
  if (!count || count < 1 || count > 50) {
    return res
      .status(400)
      .json({ error: "groupCount must be between 1 and 50" });
  }
  if (
    !namingPattern ||
    typeof namingPattern !== "string" ||
    !namingPattern.includes("{n}")
  ) {
    return res
      .status(400)
      .json({ error: "namingPattern must be a string containing {n}" });
  }
  if (messages && !Array.isArray(messages)) {
    return res
      .status(400)
      .json({ error: "messages must be an array of strings" });
  }

  try {
    // Ensure the account belongs to the caller's workspace before doing any work.
    const { data: owned } = await supabase
      .from("telegram_accounts")
      .select("phone")
      .eq("phone", phone)
      .eq("workspace", ws)
      .single();
    if (!owned) {
      return res.status(404).json({ success: false, error: "Account not found" });
    }

    const result = await createGroups(
      phone,
      count,
      namingPattern,
      description,
      messages,
      entityType,
      ws
    );

    // Get updated rate limit info
    const { data: updatedLimit } = await supabase.rpc("check_rate_limit", {
      account_phone: phone,
    });

    return res.json({
      success: true,
      data: {
        success: true,
        results: result.results,
        groupsCreated: result.successfulGroups,
        rateLimitInfo: updatedLimit,
      },
    });
  } catch (err: any) {
    broadcastLog({
      message: `Unexpected error: ${err.message}`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
    return res.status(500).json({
      success: false,
      error: err.message || "An unexpected error occurred",
    });
  }
});

// POST /accounts/update-rate-limit
router.post(
  "/accounts/update-rate-limit",
  async (req: Request, res: Response) => {
    const ws = getWorkspace(req);
    const { phone, wait_seconds } = req.body;

    if (!phone || typeof phone !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid phone parameter",
      });
    }

    if (typeof wait_seconds !== "number" || wait_seconds <= 0) {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid wait_seconds parameter",
      });
    }

    try {
      // Manually park an account for wait_seconds. Use flood_wait_until so it
      // actually blocks under the new logic (next_available_time is only the
      // 24h window marker and no longer blocks on its own).
      const floodWaitUntil = new Date(Date.now() + wait_seconds * 1000);

      const { error: updateError } = await supabase
        .from("telegram_accounts")
        .update({
          flood_wait_until: floodWaitUntil.toISOString(),
        })
        .eq("phone", phone)
        .eq("workspace", ws);

      if (updateError) {
        console.error("Failed to update account rate limit:", updateError);
        return res.status(500).json({
          success: false,
          error: "Failed to update account rate limit information",
        });
      }

      res.json({
        success: true,
        message: "Account rate limit updated successfully",
        data: {
          phone,
          wait_seconds,
          floodWaitUntil,
        },
      });
    } catch (err) {
      console.error("Error handling rate limit update:", err);
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : "Unknown error occurred",
      });
    }
  }
);

// POST /bots/create - create N bots for one account via BotFather (synchronous)
router.post("/bots/create", async (req: Request, res: Response) => {
  const ws = getWorkspace(req);
  const { phone, botCount, useCustomPattern, theme } = req.body;

  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ error: "Missing or invalid phone" });
  }
  const count = Number(botCount);
  if (!count || count < 1 || count > 20) {
    return res.status(400).json({ error: "botCount must be between 1 and 20" });
  }
  if (useCustomPattern && (!theme || typeof theme !== "string")) {
    return res
      .status(400)
      .json({ error: "A theme is required when using a custom pattern" });
  }

  try {
    // Ensure the account belongs to the caller's workspace.
    const { data: owned } = await supabase
      .from("telegram_accounts")
      .select("phone")
      .eq("phone", phone)
      .eq("workspace", ws)
      .single();
    if (!owned) {
      return res.status(404).json({ success: false, error: "Account not found" });
    }

    const result = await createBots(
      phone,
      count,
      !!useCustomPattern,
      theme,
      ws
    );

    return res.json({
      success: true,
      data: {
        botsCreated: result.botsCreated,
        totalBots: result.totalBots,
      },
    });
  } catch (err: any) {
    broadcastLog({
      message: `Unexpected error creating bots: ${err.message}`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
    return res.status(500).json({
      success: false,
      error: err.message || "An unexpected error occurred",
    });
  }
});

// GET /bots - list bots for the caller's workspace (tokens omitted for safety)
router.get("/bots", async (req: Request, res: Response) => {
  const ws = getWorkspace(req);
  try {
    const { data, error } = await supabase
      .from("telegram_bots")
      .select("id, username, display_name, owner_phone, theme, created_at")
      .eq("workspace", ws)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase error (bots):", error);
      return res.status(500).json({ success: false, error: "Failed to fetch bots" });
    }

    return res.json({ success: true, data: data || [] });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err.message || "Failed to fetch bots" });
  }
});

export default router;
