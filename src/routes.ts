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
    processQueue();

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

// Short spacing between consecutive bot creations on the SAME account. The real
// safety gate is the 3-per-24h daily limit (check_bot_limits), so this is just a
// light anti-flood gap — kept small for speed. Override via env.
const BOT_COOLDOWN_MS = Number(process.env.BOT_COOLDOWN_MS) || 60 * 1000;
// Back-off when BotFather actively rate-limits us ("too many attempts") but did
// NOT tell us how long to wait. When it DOES give a number ("try again in 129
// seconds") we honor that exact time instead (see runOneBotStep).
const BOT_FLOOD_BACKOFF_MS =
  Number(process.env.BOT_FLOOD_BACKOFF_MS) || 30 * 60 * 1000;
// Back-off after a generic failure (timeout / unexpected error). Conservative so
// a broken account can't hammer BotFather; other accounts run meanwhile.
const BOT_ERROR_BACKOFF_MS =
  Number(process.env.BOT_ERROR_BACKOFF_MS) || 30 * 60 * 1000;
// A flood delay is never allowed to be shorter than this (BotFather can lie low).
const BOT_FLOOD_MIN_MS = 60 * 1000;
// ...nor longer than this from a single "try again in N" reply (safety ceiling).
const BOT_FLOOD_MAX_MS = 6 * 60 * 60 * 1000;
// Cap on a single cooldown sleep so newly-enqueued jobs get picked up promptly.
const SCHEDULER_MAX_SLEEP_MS = 60 * 1000;
// Give up on a bot job after this many failed attempts (per job) to avoid loops.
const MAX_BOT_FAILURES = 12;

// Turn a bot-step failure into the number of ms to wait before retrying it.
// Foolproof by construction: every non-success reason maps to a bounded, always
// positive delay, so a job can never spin without pause or wait forever.
//   • flood + parsed seconds → that exact time (clamped 1m…6h) + 5s jitter buffer
//   • flood, no number        → BOT_FLOOD_BACKOFF_MS (30m)
//   • timeout / error         → BOT_ERROR_BACKOFF_MS (30m)
//   • no_username             → BOT_COOLDOWN_MS (short; just AI name collisions)
function backoffForBotFailure(res: SingleBotResult): {
  ms: number;
  detail: string;
} {
  if (res.status === "flood") {
    if (res.retryAfterMs && res.retryAfterMs > 0) {
      // Absurdly long floods (>40000s ≈ 11h) mean the account is toast for the
      // day — just park it 24h rather than honoring the exact (huge) number.
      if (res.retryAfterMs > 40000 * 1000) {
        return { ms: 24 * 60 * 60 * 1000, detail: "flood >40000s → parked 24h" };
      }
      const ms = Math.min(
        Math.max(res.retryAfterMs + 5000, BOT_FLOOD_MIN_MS),
        BOT_FLOOD_MAX_MS
      );
      return { ms, detail: `BotFather asked to wait ${Math.round(res.retryAfterMs / 1000)}s` };
    }
    return { ms: BOT_FLOOD_BACKOFF_MS, detail: "flood (no time given)" };
  }
  if (res.status === "no_username") return { ms: BOT_COOLDOWN_MS, detail: "name collisions" };
  // timeout / error / anything unexpected → conservative fixed back-off.
  return { ms: BOT_ERROR_BACKOFF_MS, detail: res.status };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The single queue scheduler. Each iteration runs one "unit" of work:
//   • a full group/channel batch job (priority), OR
//   • ONE bot for the least-recently-served bot job (round-robin), honoring the
//     per-account cooldown.
// Only one account is ever online at a time (withAccountLock), so everything is
// serialized; round-robin simply spreads each account's bots over time and lets
// the 5-min cooldown elapse while other accounts are worked.
async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  try {
    // Loop until no work remains; then release so a future enqueue restarts us.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 1. Group/channel batch jobs take priority and run to completion.
      const { data: batchJob } = await supabase
        .from("group_creation_queue")
        .select("*")
        .eq("status", "pending")
        .in("type", ["group", "channel"])
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (batchJob) {
        await runBatchJob(batchJob);
        continue;
      }

      // 2. Bot jobs: pick the one due soonest (null next_attempt_at = never
      //    served = go now). Round-robin falls out of ordering by next_attempt_at.
      const { data: botJob } = await supabase
        .from("group_creation_queue")
        .select("*")
        .eq("type", "bot")
        .in("status", ["pending", "processing"])
        .order("next_attempt_at", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!botJob) return; // nothing left to do

      const dueAt = botJob.next_attempt_at
        ? new Date(botJob.next_attempt_at).getTime()
        : 0;
      const waitMs = dueAt - Date.now();
      if (waitMs > 0) {
        // Every remaining bot job is still cooling down — wait for the soonest.
        await sleep(Math.min(waitMs, SCHEDULER_MAX_SLEEP_MS));
        continue;
      }

      await runOneBotStep(botJob);
    }
  } catch (err: any) {
    broadcastLog({
      message: `Error in queue scheduler: ${err.message || "Unknown error"}`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
  } finally {
    isProcessingQueue = false;
  }
}

// Run a group/channel batch job to completion (unchanged behavior).
async function runBatchJob(job: any) {
  await supabase
    .from("group_creation_queue")
    .update({ status: "processing", started_at: new Date().toISOString() })
    .eq("id", job.id);

  const jobType: "group" | "channel" =
    job.type === "channel" ? "channel" : "group";

  broadcastLog({
    message: `Starting queued job #${job.id} for account ${job.phone} to create ${job.group_count} ${jobType}s`,
    type: "info",
    timestamp: new Date().toISOString(),
  });

  try {
    const result = await createGroups(
      job.phone,
      job.group_count,
      job.naming_pattern,
      job.description,
      job.messages,
      jobType,
      job.workspace || "default"
    );

    await supabase
      .from("group_creation_queue")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", job.id);

    broadcastLog({
      message: `Completed queued job #${job.id} for account ${job.phone} — created ${result.successfulGroups}/${result.totalGroups} ${jobType}s`,
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
}

// Create ONE bot for a bot job, then update its progress + cooldown. Never throws
// (all failure modes are turned into a status the scheduler can act on).
async function runOneBotStep(job: any) {
  const log = (message: string, type: "info" | "success" | "error" = "info") =>
    broadcastLog({ message, type, timestamp: new Date().toISOString() });

  const pattern: string = job.naming_pattern || "default";
  const nowIso = () => new Date().toISOString();

  // First touch: flip pending → processing and announce the job.
  if (job.status === "pending") {
    await supabase
      .from("group_creation_queue")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", job.id);
    log(
      `Starting bot job #${job.id} for account ${job.phone}: ${job.group_count} bot(s), ` +
        `${
          pattern === "custom"
            ? `custom theme "${job.description}"`
            : `${pattern} pattern`
        }.`
    );
  }

  // Enforce both caps BEFORE any session work (cheap DB check).
  const { data: limits } = await supabase.rpc("check_bot_limits", {
    account_phone: job.phone,
  });
  if (limits && limits.can_create === false) {
    if (limits.reason === "total") {
      await supabase.rpc("set_bots_count", { phone_number: job.phone, new_count: 20 });
      await supabase
        .from("group_creation_queue")
        .update({
          status: "completed",
          completed_at: nowIso(),
          next_attempt_at: null,
          error_message: `Reached the 20-bot total cap after ${job.bots_done ?? 0} bot(s) this run.`,
        })
        .eq("id", job.id);
      log(`Account ${job.phone} is at the 20-bot cap — job #${job.id} closed.`, "error");
      return;
    }
    if (limits.reason === "daily") {
      // Park this account until its 24h window resets; other accounts run meanwhile.
      const resetAt = limits.next_reset
        ? new Date(limits.next_reset).toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from("group_creation_queue")
        .update({ next_attempt_at: resetAt, status: "processing" })
        .eq("id", job.id);
      log(
        `Account ${job.phone} hit the 3-per-24h bot limit. Next bot after ${new Date(
          resetAt
        ).toLocaleString()}.`
      );
      return;
    }
  }

  const done = job.bots_done ?? 0;
  const failures = job.bots_attempts ?? 0;
  const workspace = job.workspace || "default";
  const theme = job.description || undefined;

  const res = await createSingleBotForAccount(
    job.phone,
    pattern,
    theme,
    workspace,
    log
  );

  if (res.status === "created") {
    const newDone = done + 1;
    if (newDone >= job.group_count) {
      await supabase
        .from("group_creation_queue")
        .update({
          bots_done: newDone,
          status: "completed",
          completed_at: nowIso(),
          next_attempt_at: null,
        })
        .eq("id", job.id);
      log(
        `Bot job #${job.id} for ${job.phone} complete — ${newDone}/${job.group_count} bots created.`,
        "success"
      );
    } else {
      const nextAt = new Date(Date.now() + BOT_COOLDOWN_MS).toISOString();
      await supabase
        .from("group_creation_queue")
        .update({ bots_done: newDone, next_attempt_at: nextAt, status: "processing" })
        .eq("id", job.id);
      log(
        `Bot ${newDone}/${job.group_count} done for ${job.phone}. Next bot for this ` +
          `account in ~${Math.round(
            BOT_COOLDOWN_MS / 60000
          )} min (other accounts run meanwhile).`
      );
    }
    return;
  }

  if (res.status === "limit") {
    // Account at Telegram's bot cap — force the counter and close the job.
    await supabase.rpc("set_bots_count", { phone_number: job.phone, new_count: 20 });
    await supabase
      .from("group_creation_queue")
      .update({
        status: "completed",
        completed_at: nowIso(),
        next_attempt_at: null,
        error_message: `Reached Telegram's bot cap after ${done} bot(s) this run.`,
      })
      .eq("id", job.id);
    log(
      `Account ${job.phone} reached the bot cap — job #${job.id} closed after ${done} bot(s).`,
      "error"
    );
    return;
  }

  // flood / timeout / error / no_username → back off and retry later, up to a cap.
  const newFailures = failures + 1;
  if (newFailures >= MAX_BOT_FAILURES) {
    await supabase
      .from("group_creation_queue")
      .update({
        status: "failed",
        completed_at: nowIso(),
        bots_attempts: newFailures,
        error_message: `Gave up after ${newFailures} failed attempts (last: ${res.status}).`,
      })
      .eq("id", job.id);
    log(
      `Bot job #${job.id} for ${job.phone} failed after ${newFailures} attempts (${res.status}).`,
      "error"
    );
    return;
  }

  const { ms: backoff, detail } = backoffForBotFailure(res);
  const nextAt = new Date(Date.now() + backoff).toISOString();
  await supabase
    .from("group_creation_queue")
    .update({ bots_attempts: newFailures, next_attempt_at: nextAt, status: "processing" })
    .eq("id", job.id);
  const mins = backoff / 60000;
  const human = mins >= 1 ? `~${Math.round(mins)} min` : `~${Math.round(backoff / 1000)}s`;
  log(
    `Bot attempt for ${job.phone} did not succeed (${res.status}: ${detail}). ` +
      `Retrying in ${human}. [${newFailures}/${MAX_BOT_FAILURES} failures]`,
    "error"
  );
}

// Export function to start the queue scheduler
export function startQueueProcessor() {
  broadcastLog({
    message: "Starting queue scheduler...",
    type: "info",
    timestamp: new Date().toISOString(),
  });
  processQueue();
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

interface SingleBotResult {
  status: "created" | "limit" | "flood" | "timeout" | "error" | "no_username";
  username?: string;
  // When status is "flood" and BotFather named a delay, this is that delay in ms.
  retryAfterMs?: number;
}

// Create exactly ONE bot for an account via @BotFather. Serialized behind the
// account lock (only one account online at a time). Never throws — every outcome
// is mapped to a status the scheduler acts on (progress / cooldown / back-off).
async function createSingleBotForAccount(
  phone: string,
  pattern: string, // 'default' | 'crypto' | 'custom'
  theme: string | undefined,
  workspace: string,
  log: (message: string, type?: "info" | "success" | "error") => void
): Promise<SingleBotResult> {
  return withAccountLock(() =>
    createSingleBotInner(phone, pattern, theme, workspace, log)
  );
}

async function createSingleBotInner(
  phone: string,
  pattern: string,
  theme: string | undefined,
  workspace: string,
  log: (message: string, type?: "info" | "success" | "error") => void
): Promise<SingleBotResult> {
  let client: any = null;
  const mode = pattern === "crypto" ? "crypto" : pattern === "custom" ? "custom" : "default";
  const usernameTheme = mode === "custom" ? theme : undefined;

  try {
    client = await getClientByPhone(phone);

    // Verify the restored session; recreate once if stale.
    try {
      const me = await client.getMe();
      log(`Account ${phone} online as @${me?.username ?? me?.firstName ?? "unknown"}.`);
    } catch (meErr: any) {
      log(
        `Session invalid for ${phone} (${meErr?.message || meErr}); recreating...`,
        "error"
      );
      await clearSession(phone);
      client = await getClientByPhone(phone);
    }

    // CRITICAL: sessions restored from a session string do NOT auto-start the
    // updates loop, so BotFather's replies would never reach waitForResponse.
    // Start it explicitly (idempotent; clearSession tears it down after).
    try {
      await client.startUpdatesLoop();
    } catch (loopErr: any) {
      log(
        `WARNING: could not start updates loop for ${phone}: ${loopErr?.message || loopErr}.`,
        "error"
      );
    }

    // One AI call yields the primary handle plus a few spares (buffer), so a
    // single /newbot cycle can absorb "username taken" collisions.
    const candidates = await generateBotUsernames({ count: 1, theme: usernameTheme, mode });
    if (candidates.length === 0) {
      log(`No usernames generated for ${phone} (check GROQ_API_KEY / Groq status).`, "error");
      return { status: "error" };
    }
    const primary = candidates[0];
    log(
      `Creating bot "${botDisplayName(primary)}" for ${phone} — trying @${candidates
        .slice(0, 6)
        .join(", @")}`
    );

    const result = await createBotViaBotFather(
      client,
      botDisplayName(primary),
      candidates.slice(0, 6),
      log
    );

    if (result.ok) {
      // Store what BotFather actually set as the name (from the primary handle).
      await supabase.from("telegram_bots").insert({
        workspace,
        owner_phone: phone,
        username: result.username,
        display_name: botDisplayName(primary),
        token: result.token,
        theme: mode === "custom" ? theme || null : mode === "crypto" ? "crypto" : null,
      });
      // Bumps both the total counter and the 3-per-24h daily counter atomically.
      await supabase.rpc("register_bot_creation", { account_phone: phone });
      // Log the handle only — never the raw token (the WS log is global).
      log(`Created bot @${result.username} for account ${phone}.`, "success");
      return { status: "created", username: result.username };
    }

    // Surface BotFather's exact "try again in N seconds" delay for flood cases.
    return {
      status: result.reason,
      retryAfterMs:
        result.reason === "flood" && result.retryAfter
          ? result.retryAfter * 1000
          : undefined,
    };
  } catch (err: any) {
    log(`Unexpected error creating bot for ${phone}: ${err?.message || err}`, "error");
    return { status: "error" };
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
        "phone, username, groups_count, channels_count, bots_count, bots_created_24h, bots_next_reset, groups_created_24h, next_available_time, flood_wait_until"
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
                bots_count: account.bots_count || 0,
                bots_created_24h: account.bots_created_24h || 0,
                bots_next_reset: account.bots_next_reset || null,
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
              bots_count: account.bots_count || 0,
              bots_created_24h: account.bots_created_24h || 0,
              bots_next_reset: account.bots_next_reset || null,
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

// POST /bots/create - enqueue a bot job for one account. Bots are created by the
// backend scheduler (round-robin across accounts, per-account cooldown + 3/24h
// daily cap), so this returns immediately with a job id; watch the queue.
router.post("/bots/create", async (req: Request, res: Response) => {
  const ws = getWorkspace(req);
  const { phone, botCount, pattern, theme } = req.body;
  const namingPattern: "default" | "crypto" | "custom" =
    pattern === "crypto" ? "crypto" : pattern === "custom" ? "custom" : "default";

  if (!phone || typeof phone !== "string") {
    return res.status(400).json({ error: "Missing or invalid phone" });
  }
  const count = Number(botCount);
  if (!count || count < 1 || count > 20) {
    return res.status(400).json({ error: "botCount must be between 1 and 20" });
  }
  if (namingPattern === "custom" && (!theme || typeof theme !== "string")) {
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

    const { data: job, error: jobError } = await supabase
      .from("group_creation_queue")
      .insert({
        phone,
        workspace: ws,
        group_count: count,
        naming_pattern: namingPattern,
        description: theme || "",
        type: "bot",
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (jobError) {
      return res.status(500).json({
        success: false,
        error: `Failed to enqueue bot job: ${jobError.message}`,
      });
    }

    processQueue();

    return res.json({ success: true, data: { job_id: job.id } });
  } catch (err: any) {
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
