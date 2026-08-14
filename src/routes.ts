import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
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
import { getBotUsernames, markTried, botDisplayName } from "./ai/groq";
import { createBotViaBotFather, deleteBotViaBotFather, listBotsViaBotFather, transferBotViaBotFather } from "./telegram/botfather";
import { listChatsForAccount, TargetKind } from "./telegram/dialogs";
import { sendToChat, SendContent } from "./telegram/send";
import { generateBroadcastMessages } from "./ai/messages";

// Where broadcast images are persisted so the async messaging scheduler can read
// them at send time (the request's in-memory buffer is gone by then). Created on
// boot by server.ts.
export const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

// Only channels created by accounts in THIS workspace get recorded into the
// sister project's protected_channels table (so its auto-leave bot skips them).
// Friends' channels are never recorded. Override via env if the name changes.
// The backend workspace defaults to "default" when no workspace key is
// configured. Keep that as the safe default so the primary workspace's channel
// creations are protected out of the box; friends can use another workspace
// explicitly via WORKSPACE_KEYS + this setting.
const PROTECTED_CHANNELS_WORKSPACE =
  process.env.PROTECTED_CHANNELS_WORKSPACE || "default";

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

// Reset the self-imposed 3-bots-per-24h window for the caller's accounts AND wake
// any bot jobs parked waiting on that window, so bot creation resumes immediately.
// This is the bot-side analog of /accounts/set-all-available (which clears the
// group rate limit). It does NOT touch bots_count, so the hard Telegram 20-bot
// total cap still applies. Use it to re-run bots without waiting out the ~24h
// window — mainly for testing. NOTE: the 3/24h throttle exists to avoid BotFather
// flood-bans; clearing it repeatedly and creating many bots fast raises that risk.
router.post(
  "/accounts/reset-bot-limits",
  async (req: Request, res: Response) => {
    try {
      const ws = getWorkspace(req);

      // 1. Clear the rolling daily bot counter for this workspace's accounts.
      const { error: acctError } = await supabase
        .from("telegram_accounts")
        .update({ bots_created_24h: 0, bots_next_reset: null })
        .eq("workspace", ws);
      if (acctError) throw acctError;

      // 2. Wake bot jobs that were parked on next_attempt_at (e.g. by the daily
      //    cap or a back-off) so the scheduler retries them now instead of at the
      //    old due time. Leaving status as-is; the scheduler picks them up.
      const { error: jobError } = await supabase
        .from("group_creation_queue")
        .update({ next_attempt_at: null })
        .eq("workspace", ws)
        .eq("type", "bot")
        .in("status", ["pending", "processing"]);
      if (jobError) throw jobError;

      // Kick the scheduler so the woken jobs run without waiting for the next tick.
      processQueue();

      res.json({
        success: true,
        message: "Bot daily limits cleared; parked bot jobs will resume now.",
      });
    } catch (error: any) {
      res
        .status(500)
        .json({ success: false, error: error?.message || "Failed to reset bot limits" });
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
    // Shared dashboard: the console log is global, so the queue is shown to all
    // users too (both workspaces see every job). Creation and cancellation stay
    // workspace-scoped; `is_owner` tells the UI which jobs the caller may cancel.
    const ws = getWorkspace(req);
    const { data: jobs, error } = await supabase
      .from("group_creation_queue")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        error: `Failed to get queue: ${error.message}`,
      });
    }

    const withOwner = (jobs || []).map((j: any) => ({
      ...j,
      is_owner: (j.workspace || "default") === ws,
    }));

    return res.json({
      success: true,
      jobs: withOwner,
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

    // Everyone can SEE every job, but only the owner (who queued it) may cancel.
    const { data: job } = await supabase
      .from("group_creation_queue")
      .select("workspace")
      .eq("id", id)
      .single();
    if (!job) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }
    if ((job.workspace || "default") !== ws) {
      return res
        .status(403)
        .json({ success: false, error: "Only the owner can cancel this job." });
    }

    const { error } = await supabase
      .from("group_creation_queue")
      .delete()
      .eq("id", id);

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

// Cooldown before the SAME account may make its next bot (round-robin works other
// accounts meanwhile). Default 5 min, per the requested "1 bot per account / 5min".
const BOT_COOLDOWN_MS = Number(process.env.BOT_COOLDOWN_MS) || 5 * 60 * 1000;
// Gap after finishing (and disconnecting) one account before touching the next
// account — a short breather between every bot step, whichever account is next.
const BOT_INTER_ACCOUNT_MS = Number(process.env.BOT_INTER_ACCOUNT_MS) || 30 * 1000;
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
// Policy: a bot/transfer job whose next attempt is further away than this is not
// worth keeping open (daily cap ≈ 24h, spam block = 24h, long floods). The
// scheduler closes it as failed instead of leaving it "processing" for a day;
// progress (bots_done) is preserved and a new job can be enqueued anytime.
const MAX_PARK_MS = Number(process.env.MAX_PARK_MS) || 60 * 60 * 1000;
// Self-healing tick: the scheduler is otherwise only kicked on boot and on each
// enqueue, so a single transient error (or an early return on a DB hiccup) used
// to strand every remaining job until the next enqueue — which never comes after
// a burst. A periodic tick re-drains any pending/parked/resumable work. It is a
// no-op whenever a loop is already running (guarded by the isProcessing* flags),
// so it costs ~2 cheap queries per interval when idle.
const QUEUE_TICK_MS = Number(process.env.QUEUE_TICK_MS) || 20 * 1000;

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
  // Spam-blocked accounts stay blocked for a long time — park a month so we
  // don't ping BotFather (and burn usernames). The admin is DMed from the
  // account itself when the block is first seen (see createSingleBotInner).
  if (res.status === "spam_block")
    return { ms: 30 * 24 * 60 * 60 * 1000, detail: "account spam-blocked (@SpamBot) → parked 30 days" };
  // timeout / error / anything unexpected → conservative fixed back-off.
  return { ms: BOT_ERROR_BACKOFF_MS, detail: res.status };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Park a job until `nextAt`, UNLESS that wait exceeds MAX_PARK_MS — then close
// it as failed right away (user policy: no job sits "processing" for hours on a
// wait it can't act on). Progress fields are preserved; re-enqueue resumes.
// Closing also stamps the account's flood_wait_until so the account selector
// shows it as unavailable until the wait actually elapses.
// `extra.forcePark` is a caller-controlled flag (NOT a DB column) that bypasses
// the MAX_PARK_MS policy for deliberate long parks (e.g. 30-day spam blocks).
// Forced parks also stamp the account's flood_wait_until so the account
// selector shows it unavailable for the full wait.
// Returns the human label used in the caller's log line.
async function parkOrFail(
  jobId: number,
  phone: string,
  waitMs: number,
  reason: string,
  extra: Record<string, any>,
  log: (message: string, type?: "info" | "success" | "error") => void
): Promise<"parked" | "failed"> {
  // Pull forcePark out of extra so it never gets written as a DB column.
  const { forcePark, ...dbExtra } = extra;

  if (waitMs > MAX_PARK_MS && !forcePark) {
    await supabase
      .from("group_creation_queue")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        next_attempt_at: null,
        error_message: `Closed: next attempt was ${Math.round(waitMs / 60000)} min away (${reason}). Re-enqueue to resume.`,
        ...dbExtra,
      })
      .eq("id", jobId);
    // The job is gone but the account is still blocked — mark it unavailable so
    // the account selector doesn't offer it before the wait is over.
    await supabase
      .from("telegram_accounts")
      .update({ flood_wait_until: new Date(Date.now() + waitMs).toISOString() })
      .eq("phone", phone);
    log(
      `Job #${jobId} closed as failed — ${reason}; retry would be in ~${Math.round(
        waitMs / 60000
      )} min (> ${Math.round(MAX_PARK_MS / 60000)} min policy). Account ${phone} marked unavailable until then. Re-enqueue to resume.`,
      "error"
    );
    return "failed";
  }

  // Park the job — either within policy, or force-parked past the policy limit.
  const nextAt = new Date(Date.now() + waitMs).toISOString();
  await supabase
    .from("group_creation_queue")
    .update({
      next_attempt_at: nextAt,
      status: "processing",
      // Marker so recoverOrphanedJobs skips genuinely long-parked jobs.
      ...(forcePark ? { error_message: `Force-parked: ${reason}` } : {}),
      ...dbExtra,
    })
    .eq("id", jobId);
  // Forced (long) parks also block the account in the selector.
  if (forcePark) {
    await supabase
      .from("telegram_accounts")
      .update({ flood_wait_until: nextAt })
      .eq("phone", phone);
  }
  return "parked";
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
    // Loop until no work remains; then release so a future enqueue (or the
    // periodic tick) restarts us. Each iteration is wrapped in its own try/catch
    // so a transient failure (a dropped Supabase connection, a throw from a job
    // step) can never kill the whole loop and strand every remaining job — the
    // exact failure mode that left jobs "processing but doing nothing". On error
    // we log, pause briefly to avoid a tight spin, and continue draining.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
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

        // 1b. Bot deletion jobs: same priority as batch jobs, run to completion.
        //     Honor next_attempt_at so a flood-parked job isn't re-picked in a
        //     hot loop — if it's not due yet, fall through; the tick retries it.
        const { data: deleteJob } = await supabase
          .from("group_creation_queue")
          .select("*")
          .eq("type", "bot_delete")
          .in("status", ["pending", "processing"])
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (deleteJob) {
          const deleteDueAt = deleteJob.next_attempt_at
            ? new Date(deleteJob.next_attempt_at).getTime()
            : 0;
          if (deleteDueAt <= Date.now()) {
            await runBotDeleteJob(deleteJob);
            continue;
          }
        }

        // 1c. Bot check jobs: reconcile telegram_bots with the account's real
        //     bot list. Same next_attempt_at handling as deletion jobs.
        const { data: checkJob } = await supabase
          .from("group_creation_queue")
          .select("*")
          .eq("type", "bot_check")
          .in("status", ["pending", "processing"])
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (checkJob) {
          const checkDueAt = checkJob.next_attempt_at
            ? new Date(checkJob.next_attempt_at).getTime()
            : 0;
          if (checkDueAt <= Date.now()) {
            await runBotCheckJob(checkJob);
            continue;
          }
        }

        // 2. Bot jobs (create + transfer): pick the one due soonest (null
        //    next_attempt_at = never served = go now). Round-robin falls out of
        //    ordering by next_attempt_at; both types share the same 5-min
        //    per-account pacing so they interleave naturally.
        const { data: botJob } = await supabase
          .from("group_creation_queue")
          .select("*")
          .in("type", ["bot", "bot_transfer"])
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

        if (botJob.type === "bot_transfer") {
          await runOneTransferStep(botJob);
        } else {
          await runOneBotStep(botJob);
        }
        // Breather after disconnecting this account before moving to the next one.
        await sleep(BOT_INTER_ACCOUNT_MS);
      } catch (iterErr: any) {
        broadcastLog({
          message: `Queue iteration error (continuing): ${
            iterErr?.message || "Unknown error"
          }`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
        // Brief pause so a persistent error (e.g. DB down) doesn't hot-loop; the
        // periodic tick will keep retrying afterwards.
        await sleep(5000);
      }
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

// Run a group/channel batch job to completion. Never throws: any failure is
// recorded on the job row so the scheduler loop keeps draining other work.
async function runBatchJob(job: any) {
  const jobType: "group" | "channel" =
    job.type === "channel" ? "channel" : "group";

  // Progress already recorded for this job from an earlier (possibly crashed)
  // run. createGroups resumes from here so it never repeats a group or reuses a
  // number.
  const alreadyDone = job.bots_done ?? 0;

  try {
    // Claim the job (pending → processing) INSIDE the try: if this update itself
    // throws (transient DB error), we fall through to the catch and mark the job
    // failed instead of letting the exception escape and kill the whole loop.
    await supabase
      .from("group_creation_queue")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", job.id);

    broadcastLog({
      message:
        `Starting queued job #${job.id} for account ${job.phone} to create ${job.group_count} ${jobType}s` +
        (alreadyDone > 0 ? ` (resuming from ${alreadyDone} already done)` : ""),
      type: "info",
      timestamp: new Date().toISOString(),
    });

    const result = await createGroups(
      job.phone,
      job.group_count,
      job.naming_pattern,
      job.description,
      job.messages,
      jobType,
      job.workspace || "default",
      job.id,
      alreadyDone
    );

    await supabase
      .from("group_creation_queue")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", job.id);

    broadcastLog({
      message: `Completed queued job #${job.id} for account ${job.phone} — ${result.totalDone}/${result.totalGroups} ${jobType}s done (${result.successfulGroups} this run)`,
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
      // 24h window reset is always > MAX_PARK_MS away → close the job instead
      // of leaving it "processing" for a day (policy: no long-parked jobs).
      const resetAt = limits.next_reset
        ? new Date(limits.next_reset).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      const outcome = await parkOrFail(
        job.id,
        job.phone,
        resetAt - Date.now(),
        "3-per-24h bot limit",
        {},
        log
      );
      if (outcome === "parked") {
        log(
          `Account ${job.phone} hit the 3-per-24h bot limit. Next bot after ${new Date(
            resetAt
          ).toLocaleString()}.`
        );
      }
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

  // flood / timeout / spam_block / no_username → back off and retry later.
  const newFailures = failures + 1;
  // Spam-blocked accounts are parked for 30 days on purpose — that's not a
  // "failure" that should ever hit MAX_BOT_FAILURES and give up the job.
  const isSpamBlock = res.status === "spam_block";
  if (!isSpamBlock && newFailures >= MAX_BOT_FAILURES) {
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
  const outcome = await parkOrFail(
    job.id,
    job.phone,
    backoff,
    `${res.status}: ${detail}`,
    { bots_attempts: newFailures, ...(isSpamBlock ? { forcePark: true } : {}) },
    log
  );
  if (outcome === "failed") return;
  const mins = backoff / 60000;
  const human = mins >= 1 ? `~${Math.round(mins)} min` : `~${Math.round(backoff / 1000)}s`;
  log(
    `Bot attempt for ${job.phone} did not succeed (${res.status}: ${detail}). ` +
      `${isSpamBlock ? "Parked for 30 days." : `Retrying in ${human}.`} [${newFailures}/${MAX_BOT_FAILURES} failures]`,
    "error"
  );
}

// ---------------------------------------------------------------------------
// Bot deletion job: delete bots one-by-one via BotFather conversation.
// Each job targets one owner account and a list of bot usernames stored as
// JSON in the job's `description` column. Progress is tracked via `bots_done`.
// 30s delay between deletions. Never throws — failures are recorded on the job.
// ---------------------------------------------------------------------------
const BOT_DELETE_DELAY_MS = 30 * 1000; // 30s between deletions

async function runBotDeleteJob(job: any) {
  const log = (message: string, type: "info" | "success" | "error" = "info") =>
    broadcastLog({ message, type, timestamp: new Date().toISOString() });

  const nowIso = () => new Date().toISOString();
  const usernames: string[] = (() => {
    try { return JSON.parse(job.description || "[]"); }
    catch { return []; }
  })();
  const total = job.group_count || usernames.length;
  const alreadyDone = job.bots_done ?? 0;

  if (!usernames.length) {
    await supabase
      .from("group_creation_queue")
      .update({ status: "completed", completed_at: nowIso() })
      .eq("id", job.id);
    return;
  }

  // Claim the job
  if (job.status === "pending") {
    await supabase
      .from("group_creation_queue")
      .update({ status: "processing", started_at: nowIso() })
      .eq("id", job.id);
    log(
      `Starting bot deletion job #${job.id} for ${job.phone}: ${total} bot(s)` +
      (alreadyDone > 0 ? ` (resuming from ${alreadyDone})` : "")
    );
  }

  let client: any = null;
  // Hold the account lock for the whole job: without it the messaging scheduler
  // can bring another account online mid-conversation, whose getClientByPhone →
  // clearAllSessionsExcept destroys OUR client ("Client is destroyed" crash).
  await withAccountLock(async () => {
  try {
    client = await getClientByPhone(job.phone);

    // Verify session
    try {
      const me = await client.getMe();
      log(`Account ${job.phone} online as @${me?.username ?? me?.firstName ?? "unknown"}.`);
    } catch (meErr: any) {
      log(`Session invalid for ${job.phone} (${meErr?.message || meErr}); recreating...`, "error");
      await clearSession(job.phone);
      client = await getClientByPhone(job.phone);
    }

    // Start updates loop for BotFather conversation
    try { await client.startUpdatesLoop(); } catch { /* may already be running */ }

    // Delete bots starting from where we left off
    for (let i = alreadyDone; i < usernames.length; i++) {
      const username = usernames[i];

      // Check for cancellation every bot
      const { data: fresh } = await supabase
        .from("group_creation_queue")
        .select("status")
        .eq("id", job.id)
        .single();
      if (fresh && fresh.status !== "processing") {
        log(`Deletion job #${job.id} cancelled mid-run.`);
        return;
      }

      log(`Deleting bot @${username} (${i + 1}/${total})...`);
      const result = await deleteBotViaBotFather(client, username, log);

      if (result.ok) {
        // Delete from telegram_bots table
        const { data: botRow } = await supabase
          .from("telegram_bots")
          .select("pattern")
          .eq("username", username)
          .eq("owner_phone", job.phone)
          .single();

        await supabase
          .from("telegram_bots")
          .delete()
          .eq("username", username)
          .eq("owner_phone", job.phone);

        // Decrement counters
        const pattern = botRow?.pattern || "default";
        await supabase.rpc("register_bot_deletion", {
          account_phone: job.phone,
          bot_pattern: pattern,
        });
      } else if (result.reason === "flood") {
        // Park the job and retry later
        const retryAfter = 15 * 60 * 1000; // 15 min default
        const nextAt = new Date(Date.now() + retryAfter).toISOString();
        await supabase
          .from("group_creation_queue")
          .update({ bots_done: i, next_attempt_at: nextAt, status: "processing" })
          .eq("id", job.id);
        log(
          `Flood during deletion of @${username} — parking for ~15 min. (${i}/${total} done)`,
          "error"
        );
        return; // will resume on next tick
      } else {
        // timeout / error / not_found — log and continue with next bot
        log(`Failed to delete @${username}: ${result.reason} — skipping.`, "error");
      }

      // Update progress
      await supabase
        .from("group_creation_queue")
        .update({ bots_done: i + 1 })
        .eq("id", job.id);

      // Delay between deletions (skip after last)
      if (i < usernames.length - 1) {
        await sleep(BOT_DELETE_DELAY_MS);
      }
    }

    // All done
    await supabase
      .from("group_creation_queue")
      .update({ status: "completed", completed_at: nowIso() })
      .eq("id", job.id);
    log(`Bot deletion job #${job.id} complete — ${total} bot(s) processed.`, "success");
  } catch (err: any) {
    await supabase
      .from("group_creation_queue")
      .update({ status: "failed", completed_at: nowIso(), error_message: err?.message || "Unknown error" })
      .eq("id", job.id);
    log(`Bot deletion job #${job.id} failed: ${err?.message || "Unknown error"}`, "error");
  } finally {
    if (client) {
      try { await clearSession(job.phone); } catch { /* ignore */ }
    }
  }
  });
}

// ---------------------------------------------------------------------------
// Bot transfer job: hand bots over to a new owner via BotFather, ONE bot per
// step, paced like bot creation (5-min per-account cooldown, round-robin with
// other bot jobs). Each job targets one owner account; its payload lives as
// JSON in `description`: { usernames, recipient, password }. Telegram caps
// transfers at 3 per account per 24h (check_transfer_limits) — when the cap is
// hit the job parks until the window resets. Never throws.
// ---------------------------------------------------------------------------
type TransferPayload = { usernames: string[]; recipient: string; password?: string };

async function runOneTransferStep(job: any) {
  const log = (message: string, type: "info" | "success" | "error" = "info") =>
    broadcastLog({ message, type, timestamp: new Date().toISOString() });
  const nowIso = () => new Date().toISOString();

  const payload: TransferPayload = (() => {
    try { return JSON.parse(job.description || "{}"); }
    catch { return { usernames: [], recipient: "" }; }
  })();
  const usernames = payload.usernames || [];
  const total = job.group_count || usernames.length;
  const done = job.bots_done ?? 0;

  if (!usernames.length || !payload.recipient || done >= usernames.length) {
    await supabase
      .from("group_creation_queue")
      .update({ status: "completed", completed_at: nowIso(), next_attempt_at: null })
      .eq("id", job.id);
    return;
  }

  // First touch: flip pending → processing and announce the job.
  if (job.status === "pending") {
    await supabase
      .from("group_creation_queue")
      .update({ status: "processing", started_at: nowIso() })
      .eq("id", job.id);
    log(
      `Starting transfer job #${job.id} for ${job.phone}: ${total} bot(s) → @${payload.recipient.replace(/^@/, "")}.`
    );
  }

  // Enforce the 3-transfers/24h cap BEFORE any session work (cheap DB check).
  const { data: limits } = await supabase.rpc("check_transfer_limits", {
    account_phone: job.phone,
  });
  if (limits && limits.can_transfer === false) {
    const resetAt = limits.next_reset
      ? new Date(limits.next_reset).getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    const outcome = await parkOrFail(
      job.id,
      job.phone,
      resetAt - Date.now(),
      "3-per-24h transfer limit",
      {},
      log
    );
    if (outcome === "parked") {
      log(
        `Account ${job.phone} hit the 3-per-24h transfer limit. Next transfer after ${new Date(
          resetAt
        ).toLocaleString()}. (${done}/${total} done)`
      );
    }
    return;
  }

  const username = usernames[done];
  let client: any = null;
  const result = await withAccountLock(async () => {
    try {
      client = await getClientByPhone(job.phone);
      try {
        const me = await client.getMe();
        log(`Account ${job.phone} online as @${me?.username ?? me?.firstName ?? "unknown"}.`);
      } catch (meErr: any) {
        log(`Session invalid for ${job.phone} (${meErr?.message || meErr}); recreating...`, "error");
        await clearSession(job.phone);
        client = await getClientByPhone(job.phone);
      }
      try { await client.startUpdatesLoop(); } catch { /* may already be running */ }

      log(`Transferring bot @${username} (${done + 1}/${total}) to @${payload.recipient.replace(/^@/, "")}...`);
      return await transferBotViaBotFather(client, username, payload.recipient, payload.password, log);
    } catch (err: any) {
      return { ok: false as const, reason: "error" as const, message: String(err?.message || err) };
    } finally {
      if (client) {
        try { await clearSession(job.phone); } catch { /* ignore */ }
      }
    }
  });

  // Advance to the next bot (shared by success and skip cases below).
  const advance = async (extra: Record<string, any> = {}) => {
    const newDone = done + 1;
    if (newDone >= usernames.length) {
      await supabase
        .from("group_creation_queue")
        .update({ bots_done: newDone, status: "completed", completed_at: nowIso(), next_attempt_at: null, ...extra })
        .eq("id", job.id);
      log(`Transfer job #${job.id} for ${job.phone} complete — ${newDone}/${total} bot(s) processed.`, "success");
    } else {
      const nextAt = new Date(Date.now() + BOT_COOLDOWN_MS).toISOString();
      await supabase
        .from("group_creation_queue")
        .update({ bots_done: newDone, next_attempt_at: nextAt, status: "processing", ...extra })
        .eq("id", job.id);
      log(
        `Transfer ${newDone}/${total} step done for ${job.phone}. Next transfer for this ` +
          `account in ~${Math.round(BOT_COOLDOWN_MS / 60000)} min (other accounts run meanwhile).`
      );
    }
  };

  if (result.ok) {
    // The bot left this account — drop its row and fix the counters.
    const { data: botRow } = await supabase
      .from("telegram_bots")
      .select("pattern")
      .eq("username", username)
      .eq("owner_phone", job.phone)
      .single();
    await supabase
      .from("telegram_bots")
      .delete()
      .eq("username", username)
      .eq("owner_phone", job.phone);
    await supabase.rpc("register_bot_transfer", {
      account_phone: job.phone,
      bot_pattern: botRow?.pattern || "default",
    });
    await advance();
    return;
  }

  if (result.reason === "recipient_invalid" || result.reason === "not_found") {
    // Recipient never messaged this bot / bot gone — skip it, keep going.
    log(`Skipping @${username}: ${result.reason} — ${result.message}`, "error");
    await advance({ error_message: `@${username}: ${result.reason}` });
    return;
  }

  if (result.reason === "bad_password" || result.reason === "needs_password") {
    // A wrong/missing 2FA password can never succeed on retry — fail the job.
    await supabase
      .from("group_creation_queue")
      .update({
        status: "failed",
        completed_at: nowIso(),
        error_message: `2FA problem (${result.reason}): ${result.message}`,
      })
      .eq("id", job.id);
    log(`Transfer job #${job.id} failed: 2FA ${result.reason} for ${job.phone}.`, "error");
    return;
  }

  // flood / timeout / error → back off and retry the SAME bot later, up to a cap.
  const failures = (job.bots_attempts ?? 0) + 1;
  if (failures >= MAX_BOT_FAILURES) {
    await supabase
      .from("group_creation_queue")
      .update({
        status: "failed",
        completed_at: nowIso(),
        bots_attempts: failures,
        error_message: `Gave up after ${failures} failed attempts (last: ${result.reason}).`,
      })
      .eq("id", job.id);
    log(`Transfer job #${job.id} for ${job.phone} failed after ${failures} attempts (${result.reason}).`, "error");
    return;
  }
  const { ms: backoff, detail } = backoffForBotFailure({
    status: result.reason as "flood" | "timeout" | "error",
    retryAfterMs: result.reason === "flood" && result.retryAfter ? result.retryAfter * 1000 : undefined,
  });
  const outcome = await parkOrFail(
    job.id,
    job.phone,
    backoff,
    `${result.reason}: ${detail}`,
    { bots_attempts: failures },
    log
  );
  if (outcome === "failed") return;
  log(
    `Transfer attempt for ${job.phone} did not succeed (${result.reason}: ${detail}). ` +
      `Retrying in ~${Math.round(backoff / 60000)} min. [${failures}/${MAX_BOT_FAILURES} failures]`,
    "error"
  );
}

// ---------------------------------------------------------------------------
// Bot check job: reconcile telegram_bots with the account's REAL bot list from
// BotFather /mybots. Two fixes:
//   • DB row whose bot is gone (transferred away) → delete the row.
//   • Bot on the account with no DB row → save it with the placeholder token
//     "9999999999:unknown" so mass-delete (which parses the token's numeric
//     prefix into bot_id) can target it at any threshold.
// Afterwards bots_count / per-pattern counters are recomputed from reality.
// One job per account; never throws.
// ---------------------------------------------------------------------------
const UNKNOWN_BOT_TOKEN = "9999999999:unknown";

async function runBotCheckJob(job: any) {
  const log = (message: string, type: "info" | "success" | "error" = "info") =>
    broadcastLog({ message, type, timestamp: new Date().toISOString() });
  const nowIso = () => new Date().toISOString();

  if (job.status === "pending") {
    await supabase
      .from("group_creation_queue")
      .update({ status: "processing", started_at: nowIso() })
      .eq("id", job.id);
    log(`Starting bot check job #${job.id} for ${job.phone}.`);
  }

  let client: any = null;
  // Hold the account lock for the whole job (same reason as runBotDeleteJob).
  await withAccountLock(async () => {
  try {
    client = await getClientByPhone(job.phone);

    try {
      const me = await client.getMe();
      log(`Account ${job.phone} online as @${me?.username ?? me?.firstName ?? "unknown"}.`);
    } catch (meErr: any) {
      log(`Session invalid for ${job.phone} (${meErr?.message || meErr}); recreating...`, "error");
      await clearSession(job.phone);
      client = await getClientByPhone(job.phone);
    }

    try { await client.startUpdatesLoop(); } catch { /* may already be running */ }

    const listed = await listBotsViaBotFather(client, log);
    if (!listed.ok) {
      if (listed.reason === "flood") {
        const waitMs = Math.min(
          Math.max((listed.retryAfter ?? 900) * 1000, BOT_FLOOD_MIN_MS),
          BOT_FLOOD_MAX_MS
        );
        const nextAt = new Date(Date.now() + waitMs).toISOString();
        await supabase
          .from("group_creation_queue")
          .update({ next_attempt_at: nextAt, status: "processing" })
          .eq("id", job.id);
        log(
          `Flood while listing bots for ${job.phone} — retrying in ~${Math.round(waitMs / 60000)} min.`,
          "error"
        );
        return;
      }
      await supabase
        .from("group_creation_queue")
        .update({ status: "failed", completed_at: nowIso(), error_message: listed.message })
        .eq("id", job.id);
      log(`Bot check job #${job.id} for ${job.phone} failed: ${listed.message}`, "error");
      return;
    }

    const real = new Set(listed.usernames);
    log(`BotFather lists ${real.size} bot(s) for ${job.phone}.`);

    const { data: rows, error: rowsErr } = await supabase
      .from("telegram_bots")
      .select("id, username, pattern")
      .eq("owner_phone", job.phone);
    if (rowsErr) throw new Error(rowsErr.message);

    // 1. Stale rows: in the DB but not on the account anymore (transferred).
    const stale = (rows || []).filter((r: any) => !real.has(r.username.toLowerCase()));
    for (const r of stale) {
      await supabase.from("telegram_bots").delete().eq("id", r.id);
      log(`Removed stale DB row for @${r.username} (no longer on ${job.phone}).`);
    }

    // 2. Unsaved bots: on the account but missing from the DB. If the row lives
    // under ANOTHER owner (transferred between our accounts), move it — never
    // clobber its real token with the placeholder. Otherwise insert a
    // placeholder row mass-delete can target.
    const known = new Set((rows || []).map((r: any) => r.username.toLowerCase()));
    const missing = listed.usernames.filter((u) => !known.has(u));
    if (missing.length) {
      const { data: elsewhere } = await supabase
        .from("telegram_bots")
        .select("id, username, owner_phone")
        .in("username", missing);
      const byName = new Map(
        (elsewhere || []).map((r: any) => [r.username.toLowerCase(), r])
      );
      for (const username of missing) {
        const existing = byName.get(username);
        if (existing) {
          await supabase
            .from("telegram_bots")
            .update({ owner_phone: job.phone, workspace: job.workspace || "default" })
            .eq("id", existing.id);
          log(`Moved @${username} from ${existing.owner_phone} to ${job.phone}.`);
        } else {
          // ponytail: pattern guessed from the handle (crypto* → crypto), good
          // enough for the 10/10 split; correct manually if a custom bot slips in.
          const pattern = username.startsWith("crypto") ? "crypto" : "default";
          const { error: insErr } = await supabase.from("telegram_bots").insert({
            workspace: job.workspace || "default",
            owner_phone: job.phone,
            username,
            display_name: null,
            token: UNKNOWN_BOT_TOKEN,
            theme: pattern === "crypto" ? "crypto" : null,
            pattern,
          });
          if (insErr) log(`Could not save @${username}: ${insErr.message}`, "error");
          else log(`Saved unlisted bot @${username} with placeholder token (ID 9999999999).`);
        }
      }
    }

    // 3. Recompute account counters from reality (24h window left untouched —
    // creations already spent stay spent).
    const { data: after } = await supabase
      .from("telegram_bots")
      .select("pattern")
      .eq("owner_phone", job.phone);
    await supabase
      .from("telegram_accounts")
      .update({
        bots_count: real.size,
        default_bots_count: (after || []).filter((r: any) => r.pattern === "default").length,
        crypto_bots_count: (after || []).filter((r: any) => r.pattern === "crypto").length,
      })
      .eq("phone", job.phone);

    await supabase
      .from("group_creation_queue")
      .update({ status: "completed", completed_at: nowIso(), bots_done: 1, next_attempt_at: null })
      .eq("id", job.id);
    log(
      `Bot check for ${job.phone} done — ${real.size} real bot(s), ` +
        `${stale.length} stale row(s) removed, ${missing.length} unsaved bot(s) recorded.`,
      "success"
    );
  } catch (err: any) {
    await supabase
      .from("group_creation_queue")
      .update({ status: "failed", completed_at: nowIso(), error_message: err?.message || "Unknown error" })
      .eq("id", job.id);
    log(`Bot check job #${job.id} failed: ${err?.message || "Unknown error"}`, "error");
  } finally {
    if (client) {
      try { await clearSession(job.phone); } catch { /* ignore */ }
    }
  }
  });
}

// Recover jobs stranded by a previous process death or a loop that crashed while
// a job was mid-flight. Group/channel batch rows are the only ones with no other
// recovery path (the scheduler only selects `pending` for them), so a row left in
// `processing` is orphaned forever otherwise. We reset ONLY rows whose `started_at`
// is older than a staleness window, so a genuinely in-flight job on a live loop is
// never yanked back. Bot/messaging rows already self-heal (they select
// `processing` too), so they need no reset here.
//
// The window must sit ABOVE the longest a job can legitimately stay `processing`
// on a live loop: createGroupsInner waits out short flood waits inline (up to
// ~1h), so a healthy job can hold `processing` for close to an hour. We use 2h so
// recovery only ever touches genuinely dead rows. Jobs stranded by an earlier
// crash carry an old `started_at`, so they're recovered on the first boot/tick.
const ORPHAN_STALE_MS = Number(process.env.ORPHAN_STALE_MS) || 2 * 60 * 60 * 1000;

// `immediate` (boot): reset ALL processing batch rows — a fresh process has no
// loop running, so every processing row is by definition orphaned, and resume is
// safe (bots_done is preserved and createGroups continues from it). `immediate`
// false (tick): only reset rows older than the staleness window, since a live loop
// may legitimately hold a job in processing for up to ~1h during an inline flood
// wait. bots_done is never cleared, so progress survives the reset.
async function recoverOrphanedJobs(immediate = false) {
  // Enforce the no-long-parks policy on jobs parked BEFORE this policy existed
  // (or by any path that slips through): any open bot/transfer job whose next
  // attempt is further than MAX_PARK_MS away gets closed as failed. Runs on
  // boot and every tick; matches at most a handful of rows, so it's cheap.
  try {
    const horizon = new Date(Date.now() + MAX_PARK_MS).toISOString();
    const { data: closed } = await supabase
      .from("group_creation_queue")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: `Closed: next attempt was more than ${Math.round(MAX_PARK_MS / 60000)} min away. Re-enqueue to resume.`,
      })
      .in("type", ["bot", "bot_transfer"])
      .in("status", ["pending", "processing"])
      .gt("next_attempt_at", horizon)
      // Skip force-parked jobs (e.g. 30-day spam blocks) — those are parked on
      // purpose past MAX_PARK_MS and must not be closed by the reaper. NULL
      // error_message (legacy orphaned jobs) is still reaped.
      .or("error_message.is.null,error_message.not.ilike.Force-parked%")
      .select("id, phone, next_attempt_at");
    if (closed && closed.length) {
      // Keep the selector honest: the accounts are still blocked until their
      // (now-discarded) next_attempt_at, so mirror it into flood_wait_until.
      for (const r of closed as any[]) {
        await supabase
          .from("telegram_accounts")
          .update({ flood_wait_until: r.next_attempt_at })
          .eq("phone", r.phone);
      }
      broadcastLog({
        message: `Closed ${closed.length} long-parked bot job(s) (next attempt > ${Math.round(
          MAX_PARK_MS / 60000
        )} min away): ${closed.map((r: any) => `#${r.id} ${r.phone}`).join(", ")}. Re-enqueue to resume.`,
        type: "info",
        timestamp: new Date().toISOString(),
      });
    }
  } catch {
    /* best-effort; next tick retries */
  }

  try {
    let query = supabase
      .from("group_creation_queue")
      .update({ status: "pending", started_at: null })
      .in("type", ["group", "channel"])
      .eq("status", "processing");

    if (!immediate) {
      const cutoff = new Date(Date.now() - ORPHAN_STALE_MS).toISOString();
      // Include rows with a null started_at (claimed but never stamped) as a safety net.
      query = query.or(`started_at.is.null,started_at.lt.${cutoff}`);
    }

    const { data: reset, error } = await query.select("id");

    if (error) {
      broadcastLog({
        message: `Orphan recovery query failed: ${error.message}`,
        type: "error",
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (reset && reset.length) {
      broadcastLog({
        message: `Recovered ${reset.length} stranded group/channel job(s) back to pending (job ids: ${reset
          .map((r: any) => r.id)
          .join(", ")}).`,
        type: "info",
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    broadcastLog({
      message: `Orphan recovery error: ${err?.message || "Unknown error"}`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
  }
}

// Export function to start the queue scheduler
export function startQueueProcessor() {
  broadcastLog({
    message: "Starting queue scheduler...",
    type: "info",
    timestamp: new Date().toISOString(),
  });
  // Reconcile stranded jobs from a prior crash/restart, then kick the loop. At
  // boot nothing is running, so recover ALL orphaned batch rows immediately.
  recoverOrphanedJobs(true).finally(() => processQueue());

  // Self-healing tick: re-drain the queue on a fixed interval. This is the key
  // safeguard — the loop is otherwise only started on boot and on enqueue, so any
  // error that ended it (or a job parked for later) would sit untouched until the
  // next enqueue. The tick also re-runs orphan recovery so a job stranded by a
  // mid-flight crash is picked up without a redeploy. Cheap and idempotent:
  // processQueue() returns immediately if a loop is already running.
  setInterval(() => {
    recoverOrphanedJobs().finally(() => processQueue());
  }, QUEUE_TICK_MS).unref?.();
}

interface CreateGroupsResult {
  success: boolean;
  totalGroups: number;
  successfulGroups: number; // groups created in THIS run
  totalDone: number; // cumulative for the job (alreadyDone + this run)
  results: any[];
}

// Persist ONE successful group/channel creation immediately. Doing this per group
// (instead of once at the end) means a crash mid-batch never loses the count or
// lets a resume reuse a number. It's effectively free at scale: the global account
// lock + the 5s inter-group delay cap creations at ~1 every 5s system-wide.
//   • account groups_count (+ groups_created_24h) bumps by 1 — drives {n} numbering
//     and the rate limits, and is what was previously lost on a crash.
//   • channels_count bumps too for channels (display breakdown).
//   • the 24h window marker starts on the first success (idempotent via coalesce).
//   • the queue row's bots_done advances to the running per-job total so a resume
//     continues from exactly here (no duplicates, no over-creation).
async function persistOneCreation(
  phone: string,
  type: "group" | "channel",
  jobId: number | undefined,
  doneForJob: number,
  isFirstSuccess: boolean
): Promise<void> {
  await supabase.rpc("increment_groups_count", {
    phone_number: phone,
    increment_amount: 1,
  });
  if (type === "channel") {
    await supabase.rpc("increment_channels_count", {
      phone_number: phone,
      increment_amount: 1,
    });
  }
  if (isFirstSuccess) {
    await supabase.rpc("update_rate_limit_status", {
      account_phone: phone,
      groups_created: 1,
    });
  }
  if (jobId != null) {
    await supabase
      .from("group_creation_queue")
      .update({ bots_done: doneForJob })
      .eq("id", jobId);
  }
}

// Single source of truth for group/channel creation logic.
// jobId/alreadyDone are set for queued batch jobs so progress is durable and
// resumable; the direct POST /groups/create path leaves them at their defaults.
async function createGroups(
  phone: string,
  groupCount: number,
  namingPattern: string,
  description?: string,
  messages?: any[],
  type: "group" | "channel" = "group",
  workspace: string = "default",
  jobId?: number,
  alreadyDone: number = 0
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
      workspace,
      jobId,
      alreadyDone
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
  workspace: string = "default",
  jobId?: number,
  alreadyDone: number = 0
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

    // Resume-aware: only create what this job still owes. alreadyDone reflects the
    // successes durably recorded in a previous (crashed) run, so a re-run never
    // repeats them. `liveCount` drives {n} and advances only on success, so numbers
    // stay contiguous across crashes (currentGroupsCount already includes any prior
    // successes because we persist per group).
    const remaining = Math.max(0, groupCount - alreadyDone);
    let liveCount = currentGroupsCount;

    broadcastLog({
      message:
        `Starting creation of ${remaining} ${entity}s for account ${phone}` +
        (alreadyDone > 0 ? ` (resuming — ${alreadyDone}/${groupCount} already done)` : ""),
      type: "info",
      timestamp: new Date().toISOString(),
    });

    broadcastLog({
      message: `Account ${phone} status: ${limitCheck.groups_created_24h}/50 groups today, can_create: ${limitCheck.can_create}, total groups: ${limitCheck.total_groups}`,
      type: "info",
      timestamp: new Date().toISOString(),
    });

    for (let k = 0; k < remaining; k++) {
      const groupNumber = liveCount + 1;
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
            const protectedOk = await recordProtectedChannel(phone, chat.id, title);
            if (!protectedOk) {
              groupResult.protectionError =
                "Channel was created, but protected_channels sync failed";
            }
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

      // Persist this creation immediately (count + numbering + job progress) so a
      // crash on the very next line can't lose it. Best-effort: a transient write
      // failure logs and continues rather than aborting the whole batch.
      if (groupResult.success) {
        successfulGroups++;
        liveCount++;
        try {
          await persistOneCreation(
            phone,
            type,
            jobId,
            alreadyDone + successfulGroups,
            successfulGroups === 1
          );
        } catch (persistErr: any) {
          broadcastLog({
            message: `Warning: created ${title} but failed to persist its count (${
              persistErr?.message || persistErr
            }). Continuing.`,
            type: "error",
            timestamp: new Date().toISOString(),
          });
        }
      }

      results.push(groupResult);

      // Delay between groups (skip delay after the last one or after a break above).
      if (k < remaining - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    // NOTE: counts are now persisted per group (see persistOneCreation above), so
    // there is deliberately no bulk end-of-batch increment here — that end-only
    // write is exactly what lost progress when a run crashed mid-batch.

    return {
      success: true,
      totalGroups: groupCount,
      successfulGroups,
      totalDone: alreadyDone + successfulGroups,
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
  status: "created" | "limit" | "flood" | "timeout" | "error" | "no_username" | "spam_block";
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

    // getBotUsernames draws from a shared, batched pool so most bots cost no API
    // call (leftovers from an earlier generation are reused across jobs). A single
    // /newbot cycle sends up to 6 candidates to absorb "username taken" collisions;
    // if BotFather rejects EVERY one, we draw fresh handles for another round.
    const MAX_USERNAME_ROUNDS = 3;
    const rejected: string[] = [];
    let lastReason: SingleBotResult["status"] = "no_username";
    let lastRetryAfterMs: number | undefined;

    for (let round = 0; round < MAX_USERNAME_ROUNDS; round++) {
      const candidates = await getBotUsernames(6, {
        theme: usernameTheme,
        mode,
        avoid: rejected, // handles BotFather already refused this run
      });
      if (candidates.length === 0) {
        log(`No usernames generated for ${phone} (check CEREBRAS_API_KEY / Cerebras status).`, "error");
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
      // Every handle BotFather saw (taken/invalid or the winner) is now used —
      // stop any later job from re-attempting it.
      markTried(result.tried);

      if (result.ok) {
        // Best-effort save of the token/handle. Even if this fails, the bot DOES
        // exist on Telegram, so we still count it below — the account counters
        // (bumped by register_bot_creation), not this row, are the source of
        // truth for the dashboard.
        const { error: insertError } = await supabase
          .from("telegram_bots")
          .insert({
            workspace,
            owner_phone: phone,
            username: result.username,
            display_name: botDisplayName(primary),
            token: result.token,
            theme:
              mode === "custom" ? theme || null : mode === "crypto" ? "crypto" : null,
            pattern: mode,
          });
        if (insertError) {
          // Surface it (the token may be lost) but do NOT skip the count.
          log(
            `WARNING: bot @${result.username} was created on Telegram for ${phone} but its row could not be saved (${insertError.message}). It is still counted.`,
            "error"
          );
        }

        // Bump total + daily counters AND the matching per-pattern counter.
        await supabase.rpc("register_bot_creation", {
          account_phone: phone,
          bot_pattern: mode,
        });
        // Log the handle only — never the raw token (the WS log is global).
        log(`Created bot @${result.username} for account ${phone}.`, "success");
        return { status: "created", username: result.username };
      }

      lastReason = result.reason;
      lastRetryAfterMs =
        result.reason === "flood" && result.retryAfter ? result.retryAfter * 1000 : undefined;

      // Spam-blocked: DM the admin FROM this account while its session is still
      // live, then let the scheduler park it for a month (backoffForBotFailure).
      if (result.reason === "spam_block") {
        try {
          await client.sendText(
            "iclickcode",
            `Hi, this account (${phone}) just got spam-blocked by BotFather while creating bots:\n\n${result.message}\n\nIt has been parked for 30 days.`
          );
          log(`Notified admin @iclickcode from ${phone} about the spam block.`, "success");
        } catch (dmErr: any) {
          log(
            `Could not DM admin @iclickcode from ${phone}: ${dmErr?.message || dmErr}`,
            "error"
          );
        }
      }

      // Only "all candidates rejected" is worth another AI round. limit / flood /
      // timeout are account-level conditions the scheduler must handle, so stop.
      if (result.reason !== "no_username") break;

      rejected.push(...result.tried);
      log(
        `All candidates rejected for ${phone}; regenerating usernames avoiding ${rejected.length} used handle(s)...`
      );
    }

    // Exhausted rounds (or hit a non-retryable reason). Surface the last reason,
    // preserving BotFather's "try again in N seconds" delay for flood cases.
    return { status: lastReason, retryAfterMs: lastRetryAfterMs };
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

// Mtcute's high-level Chat.id is a marked id (-1000000000000 - bare id),
// while the auto-leave worker compares GramJS's bare positive channel id. The
// createChannel helper below currently returns raw MTProto chats (already bare),
// but normalizing here also makes backfill/future callers safe.
function toBareChannelId(channelId: any): string {
  const id = BigInt(String(channelId));
  const channelMark = BigInt("-1000000000000");
  return (id < channelMark ? channelMark - id : id).toString();
}

// Record a channel we created into the external auto-leave bot's Supabase so it
// never leaves it. Retries make transient external-DB failures recoverable while
// the timeout prevents a broken sister project from stalling the queue.
async function recordProtectedChannel(
  phone: string,
  channelId: any,
  title: string
): Promise<boolean> {
  if (!protectedDb) {
    broadcastLog({
      message: `Protected-channel sync is disabled; could not record ${title}.`,
      type: "error",
      timestamp: new Date().toISOString(),
    });
    return false;
  }

  let lastError = "Unknown error";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Never let a slow/hanging external DB stall channel creation or the queue:
      // supabase-js has no built-in timeout, so cap the write ourselves.
      const upsert = protectedDb
        .from("protected_channels")
        .upsert(
          { channel_id: toBareChannelId(channelId), phone, title },
          { onConflict: "channel_id" }
        );
      const timeout = new Promise<{ error: { message: string } }>((resolve) => {
        timer = setTimeout(
          () => resolve({ error: { message: "timed out after 10s" } }),
          10000
        );
      });
      const { error } = await Promise.race([upsert, timeout]);
      if (!error) return true;
      lastError = error.message;
    } catch (err: any) {
      lastError = err?.message || "Unknown error";
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  broadcastLog({
    message: `Could not record protected channel ${title}: ${lastError}`,
    type: "error",
    timestamp: new Date().toISOString(),
  });
  return false;
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
        "phone, username, groups_count, channels_count, bots_count, bots_created_24h, bots_next_reset, default_bots_count, crypto_bots_count, groups_created_24h, next_available_time, flood_wait_until"
      )
      .eq("workspace", ws)
      .order("phone", { ascending: true });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: "Failed to fetch accounts" });
    }

    // For each account, call check_rate_limit AND check_bot_limits and merge the
    // result. Both RPCs reset their rolling 24h counter as a side effect once the
    // window elapses, so calling them on read keeps the dashboard fresh. Without
    // the check_bot_limits call the bot counter would show a stale "3/3" until the
    // next actual bot run (it's the only other place that runs the reset).
    const accounts = data
      ? await Promise.all(
          data.map(async (account) => {
            const [
              { data: rateLimitInfo, error: rateLimitError },
              { data: botLimitInfo },
            ] = await Promise.all([
              supabase.rpc("check_rate_limit", { account_phone: account.phone }),
              supabase.rpc("check_bot_limits", { account_phone: account.phone }),
            ]);

            // Prefer the RPC's post-reset values; fall back to the raw column.
            // When the daily counter is 0 there is no active window, so drop any
            // stale next_reset marker so the UI doesn't show a phantom countdown.
            const botsCreated24h =
              botLimitInfo?.bots_created_24h ?? account.bots_created_24h ?? 0;
            const botsNextReset =
              botsCreated24h > 0
                ? botLimitInfo?.next_reset ?? account.bots_next_reset ?? null
                : null;

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
                bots_created_24h: botsCreated24h,
                bots_next_reset: botsNextReset,
                default_bots_count: account.default_bots_count || 0,
                crypto_bots_count: account.crypto_bots_count || 0,
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
              bots_created_24h: botsCreated24h,
              bots_next_reset: botsNextReset,
              default_bots_count: account.default_bots_count || 0,
              crypto_bots_count: account.crypto_bots_count || 0,
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

// Backfill channels created before protected-channel sync was fixed. This is
// intentionally explicit rather than running on every boot: it can inspect many
// Telegram dialogs and should only run for the owning workspace.
router.post("/channels/protect-existing", async (req: Request, res: Response) => {
  const ws = getWorkspace(req);
  if (ws !== PROTECTED_CHANNELS_WORKSPACE) {
    return res.status(403).json({
      success: false,
      error: "Protected-channel backfill is only available to the owning workspace.",
    });
  }
  if (!protectedDb) {
    return res.status(503).json({
      success: false,
      error:
        "Protected-channel sync is not configured. Set OTHER_SUPABASE_URL and " +
        "OTHER_SUPABASE_SERVICE_ROLE_KEY.",
    });
  }

  try {
    const { data: accounts, error: accountsError } = await supabase
      .from("telegram_accounts")
      .select("phone")
      .eq("workspace", ws)
      .order("phone");
    if (accountsError) throw accountsError;

    let discovered = 0;
    let saved = 0;
    let failed = 0;
    const accountResults: Array<Record<string, any>> = [];

    for (const account of accounts || []) {
      let client: any = null;
      let accountDiscovered = 0;
      let accountSaved = 0;
      let accountFailed = 0;
      try {
        await withAccountLock(async () => {
          client = await getClientByPhone(account.phone);
          const channels = await listChatsForAccount(client, "channel");
          accountDiscovered = channels.length;
          for (const channel of channels) {
            // `raw.id` is the bare MTProto channel id. Fall back to the
            // high-level id because toBareChannelId handles both forms.
            const channelId = channel.peer?.raw?.id ?? channel.id;
            if (await recordProtectedChannel(account.phone, channelId, channel.title)) {
              accountSaved++;
            } else {
              accountFailed++;
            }
          }
        });
      } catch (err: any) {
        accountFailed += accountDiscovered || 1;
        broadcastLog({
          message: `Protected-channel backfill failed for ${account.phone}: ${
            err?.message || "Unknown error"
          }`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
      } finally {
        if (client) {
          try {
            await clearSession(account.phone);
          } catch (_) {}
        }
      }

      discovered += accountDiscovered;
      saved += accountSaved;
      failed += accountFailed;
      accountResults.push({
        phone: account.phone,
        discovered: accountDiscovered,
        saved: accountSaved,
        failed: accountFailed,
      });
    }

    return res.json({
      success: failed === 0,
      discovered,
      saved,
      failed,
      accounts: accountResults,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to backfill protected channels",
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

// POST /bots/check — enqueue one bot_check job per phone to reconcile the DB
// with the account's real bot list (see runBotCheckJob).
router.post("/bots/check", async (req: Request, res: Response) => {
  const ws = getWorkspace(req);
  const phones: string[] = Array.isArray(req.body.phones) ? req.body.phones : [];
  if (!phones.length) {
    return res.status(400).json({ success: false, error: "phones must be a non-empty array" });
  }

  try {
    const jobIds: number[] = [];
    for (const phone of phones) {
      // Account must belong to the caller's workspace.
      const { data: owned } = await supabase
        .from("telegram_accounts")
        .select("phone")
        .eq("phone", phone)
        .eq("workspace", ws)
        .single();
      if (!owned) continue;

      // Skip if a check for this phone is already queued/running.
      const { data: dupe } = await supabase
        .from("group_creation_queue")
        .select("id")
        .eq("type", "bot_check")
        .eq("phone", phone)
        .in("status", ["pending", "processing"])
        .limit(1)
        .maybeSingle();
      if (dupe) continue;

      const { data: job, error: jobError } = await supabase
        .from("group_creation_queue")
        .insert({
          phone,
          workspace: ws,
          group_count: 1,
          naming_pattern: "check",
          description: "",
          type: "bot_check",
          status: "pending",
          created_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (jobError) {
        broadcastLog({
          message: `Failed to enqueue bot check for ${phone}: ${jobError.message}`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      jobIds.push(job.id);
    }

    processQueue();
    return res.json({ success: true, data: { job_ids: jobIds, totalJobs: jobIds.length } });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Failed to enqueue bot checks" });
  }
});

// ===========================================================================
// MASS BOT DELETION
//   • preview — returns all bots with token ID > threshold, grouped by owner
//   • confirm — creates queue job(s) to delete matched bots via BotFather
// ===========================================================================

// Fetch ALL workspace bots (supabase caps a single select at 1000 rows, so we
// page through) and keep those whose token's numeric bot ID exceeds threshold.
async function fetchBotsAboveThreshold(ws: string, threshold: number) {
  const bots = await fetchAllWorkspaceBots(ws);
  return bots.filter((b: any) => b.bot_id > threshold);
}

// Shared paged fetch: every workspace bot with its parsed numeric bot_id.
async function fetchAllWorkspaceBots(ws: string) {
  const PAGE = 1000;
  const all: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("telegram_bots")
      .select("id, username, display_name, owner_phone, token, pattern, created_at")
      .eq("workspace", ws)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all
    .map((b: any) => ({ ...b, bot_id: parseInt((b.token || "").split(":")[0], 10) }))
    .filter((b: any) => Number.isFinite(b.bot_id));
}

// POST /bots/delete/preview — show which bots would be deleted
router.post("/bots/delete/preview", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const threshold = Number(req.body.threshold) || 854;

    const matched = (await fetchBotsAboveThreshold(ws, threshold)).sort(
      (a: any, b: any) => a.bot_id - b.bot_id
    );

    // Group by owner_phone
    const groupedByOwner: Record<string, any[]> = {};
    for (const bot of matched) {
      const phone = bot.owner_phone || "unknown";
      if (!groupedByOwner[phone]) groupedByOwner[phone] = [];
      groupedByOwner[phone].push(bot);
    }

    return res.json({
      success: true,
      data: {
        bots: matched.map((b: any) => ({
          username: b.username,
          bot_id: b.bot_id,
          owner_phone: b.owner_phone,
          display_name: b.display_name,
          pattern: b.pattern,
          created_at: b.created_at,
        })),
        totalCount: matched.length,
        groupedByOwner,
      },
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Preview failed" });
  }
});

// POST /bots/delete/confirm — create deletion queue jobs
router.post("/bots/delete/confirm", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const threshold = Number(req.body.threshold) || 854;
    // Owners the user removed from the purge in the preview UI.
    const excluded = new Set<string>(
      Array.isArray(req.body.excludePhones) ? req.body.excludePhones : []
    );

    // Same paged fetch + filter as preview
    const matched = (await fetchBotsAboveThreshold(ws, threshold)).filter(
      (b: any) => !excluded.has(b.owner_phone || "unknown")
    );

    if (!matched.length) {
      return res.status(400).json({ success: false, error: "No bots matched the threshold." });
    }

    // Group by owner_phone — one queue job per owner (each needs its own account session)
    const groupedByOwner: Record<string, any[]> = {};
    for (const bot of matched) {
      const phone = bot.owner_phone || "unknown";
      if (!groupedByOwner[phone]) groupedByOwner[phone] = [];
      groupedByOwner[phone].push(bot);
    }

    const jobIds: number[] = [];

    for (const [ownerPhone, ownerBots] of Object.entries(groupedByOwner)) {
      // Verify the owner account exists in this workspace
      const { data: account } = await supabase
        .from("telegram_accounts")
        .select("phone")
        .eq("phone", ownerPhone)
        .eq("workspace", ws)
        .single();

      if (!account) {
        broadcastLog({
          message: `Skipping ${ownerBots.length} bot(s) — owner account ${ownerPhone} not found in workspace.`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const usernames = ownerBots.map((b) => b.username);

      const { data: job, error: jobError } = await supabase
        .from("group_creation_queue")
        .insert({
          phone: ownerPhone,
          workspace: ws,
          group_count: usernames.length,
          naming_pattern: String(threshold),
          description: JSON.stringify(usernames),
          type: "bot_delete",
          status: "pending",
          bots_done: 0,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (jobError) {
        broadcastLog({
          message: `Failed to create deletion job for ${ownerPhone}: ${jobError.message}`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      jobIds.push(job.id);
      broadcastLog({
        message: `Deletion job #${job.id} created for ${ownerPhone}: ${usernames.length} bot(s) to delete.`,
        type: "info",
        timestamp: new Date().toISOString(),
      });
    }

    // Kick the queue processor
    processQueue();

    return res.json({ success: true, data: { job_ids: jobIds, totalJobs: jobIds.length } });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Failed to create deletion jobs" });
  }
});

// ===========================================================================
// MASS BOT TRANSFER — hand bots below a token-ID threshold to a new owner.
//   • preview — bots with token ID BELOW threshold, grouped by owner
//   • confirm — one bot_transfer queue job per owner; payload (usernames,
//     recipient, 2FA password) rides in the job's description as JSON.
// ===========================================================================

// POST /bots/transfer/preview — show which bots could be transferred
router.post("/bots/transfer/preview", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const threshold = Number(req.body.threshold) || 0;

    const matched = (await fetchAllWorkspaceBots(ws))
      .filter((b: any) => b.bot_id < threshold)
      .sort((a: any, b: any) => a.bot_id - b.bot_id);

    const groupedByOwner: Record<string, any[]> = {};
    for (const bot of matched) {
      const phone = bot.owner_phone || "unknown";
      if (!groupedByOwner[phone]) groupedByOwner[phone] = [];
      groupedByOwner[phone].push(bot);
    }

    // Per-owner remaining transfer capacity (3/24h minus already used).
    const remainingByOwner: Record<string, number> = {};
    for (const phone of Object.keys(groupedByOwner)) {
      const { data: limits } = await supabase.rpc("check_transfer_limits", { account_phone: phone });
      remainingByOwner[phone] = limits?.can_transfer === false
        ? 0
        : Math.max(0, 3 - (limits?.bots_transferred_24h ?? 0));
    }

    return res.json({
      success: true,
      data: {
        bots: matched.map((b: any) => ({
          username: b.username,
          bot_id: b.bot_id,
          owner_phone: b.owner_phone,
          display_name: b.display_name,
          pattern: b.pattern,
          created_at: b.created_at,
        })),
        totalCount: matched.length,
        groupedByOwner,
        remainingByOwner,
      },
    });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Preview failed" });
  }
});

// POST /bots/transfer/confirm — create transfer queue jobs.
// Body: { usernames: string[], recipient: string, password?: string }
router.post("/bots/transfer/confirm", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const recipient = String(req.body.recipient || "").trim().replace(/^@/, "");
    const password = req.body.password ? String(req.body.password) : undefined;
    const wanted = new Set<string>(
      Array.isArray(req.body.usernames) ? req.body.usernames : []
    );

    if (!recipient || !/^[A-Za-z0-9_]{4,32}$/.test(recipient)) {
      return res.status(400).json({ success: false, error: "A valid recipient @username is required." });
    }
    if (!wanted.size) {
      return res.status(400).json({ success: false, error: "No bots selected." });
    }

    // Resolve the selected usernames to their owners from the DB (never trust
    // client-side owner mapping).
    const matched = (await fetchAllWorkspaceBots(ws)).filter((b: any) =>
      wanted.has(b.username)
    );
    if (!matched.length) {
      return res.status(400).json({ success: false, error: "Selected bots not found." });
    }

    const groupedByOwner: Record<string, any[]> = {};
    for (const bot of matched) {
      const phone = bot.owner_phone || "unknown";
      if (!groupedByOwner[phone]) groupedByOwner[phone] = [];
      groupedByOwner[phone].push(bot);
    }

    const jobIds: number[] = [];
    for (const [ownerPhone, ownerBots] of Object.entries(groupedByOwner)) {
      const { data: account } = await supabase
        .from("telegram_accounts")
        .select("phone")
        .eq("phone", ownerPhone)
        .eq("workspace", ws)
        .single();
      if (!account) {
        broadcastLog({
          message: `Skipping ${ownerBots.length} bot(s) — owner account ${ownerPhone} not found in workspace.`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const usernames = ownerBots.map((b) => b.username);
      const { data: job, error: jobError } = await supabase
        .from("group_creation_queue")
        .insert({
          phone: ownerPhone,
          workspace: ws,
          group_count: usernames.length,
          naming_pattern: recipient,
          description: JSON.stringify({ usernames, recipient, password }),
          type: "bot_transfer",
          status: "pending",
          bots_done: 0,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (jobError) {
        broadcastLog({
          message: `Failed to create transfer job for ${ownerPhone}: ${jobError.message}`,
          type: "error",
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      jobIds.push(job.id);
      broadcastLog({
        message: `Transfer job #${job.id} created for ${ownerPhone}: ${usernames.length} bot(s) → @${recipient}.`,
        type: "info",
        timestamp: new Date().toISOString(),
      });
    }

    processQueue();

    return res.json({ success: true, data: { job_ids: jobIds, totalJobs: jobIds.length } });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Failed to create transfer jobs" });
  }
});

// ===========================================================================
// MESSAGING: bulk-send to an account's EXISTING channels or groups.
//   • broadcast — one message (text, or image+caption) to every chat, now.
//   • drip      — X AI-generated messages per chat, one per round, spread over
//                 Y days (interval_ms between rounds).
// Chats are discovered live per round via iterDialogs (no stored chat IDs).
// Runs on its own scheduler but shares withAccountLock with the bot/group
// scheduler, so only one account is ever online at a time.
// ===========================================================================

let isProcessingMessaging = false;

// Breather after finishing (and disconnecting) one account's round before the
// next account comes online. Kept at 1 min as an anti-ban safety gap so we never
// hop between accounts back-to-back. Override via env if needed.
const MESSAGING_INTER_ACCOUNT_MS =
  Number(process.env.MESSAGING_INTER_ACCOUNT_MS) || 60 * 1000;
const MESSAGING_FLOOD_DEFAULT_MS = 15 * 60 * 1000; // park time when flood gives no number
const MESSAGING_CANCEL_CHECK_EVERY = 25; // re-check cancellation every N sends

function mlog(message: string, type: "info" | "success" | "error" = "info") {
  broadcastLog({ message, type, timestamp: new Date().toISOString() });
}

// Delete a broadcast job's uploaded image from disk (best-effort).
function cleanupJobImage(job: any) {
  if (job?.image_path) {
    fs.promises.unlink(job.image_path).catch(() => {});
  }
}

// Mark the parent job completed once none of its accounts are still pending.
async function maybeCompleteMessagingJob(jobId: number) {
  const { data: remaining } = await supabase
    .from("messaging_targets")
    .select("id")
    .eq("job_id", jobId)
    .in("status", ["pending", "processing"])
    .limit(1);
  if (remaining && remaining.length) return;

  const { data: job } = await supabase
    .from("messaging_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (!job || job.status !== "active") return;

  await supabase
    .from("messaging_jobs")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", jobId);
  cleanupJobImage(job);
  mlog(`Messaging job #${jobId} complete.`, "success");
}

// Run ONE round for one account: discover its chats and send this round's
// message to each. Advances the target's progress / cooldown; never throws.
async function runOneMessagingRound(target: any, job: any) {
  const nowIso = () => new Date().toISOString();
  const kind: TargetKind = job.target_kind === "channel" ? "channel" : "group";
  const round = target.rounds_done ?? 0;

  // First touch: flip pending → processing.
  if (target.status === "pending") {
    await supabase
      .from("messaging_targets")
      .update({ status: "processing" })
      .eq("id", target.id);
  }

  // Resolve this round's content.
  let content: SendContent;
  try {
    if (job.mode === "broadcast" && job.image_path) {
      const file = await fs.promises.readFile(job.image_path);
      content = { kind: "photo", file, caption: job.caption || undefined };
    } else {
      const pool: string[] = Array.isArray(job.message_pool) ? job.message_pool : [];
      const text = pool.length ? pool[round % pool.length] : "";
      if (!text) {
        // Nothing to send (shouldn't happen — validated at creation).
        await supabase
          .from("messaging_targets")
          .update({ status: "failed", error_message: "No message content." })
          .eq("id", target.id);
        await maybeCompleteMessagingJob(job.id);
        return;
      }
      content = { kind: "text", text };
    }
  } catch (err: any) {
    await supabase
      .from("messaging_targets")
      .update({ status: "failed", error_message: `Content error: ${err?.message || err}` })
      .eq("id", target.id);
    await maybeCompleteMessagingJob(job.id);
    return;
  }

  let sent = 0;
  let skipped = 0;
  let flooded = false;

  await withAccountLock(async () => {
    let client: any = null;
    try {
      client = await getClientByPhone(target.phone);
      const chats = await listChatsForAccount(client, kind);
      await supabase
        .from("messaging_targets")
        .update({ chats_found: chats.length })
        .eq("id", target.id);

      mlog(
        `Job #${job.id} · ${target.phone}: found ${chats.length} ${kind}(s) — ` +
          `round ${round + 1}/${job.total_rounds}.`
      );

      for (let i = 0; i < chats.length; i++) {
        // Periodically honor a mid-round cancellation.
        if (i > 0 && i % MESSAGING_CANCEL_CHECK_EVERY === 0) {
          const { data: fresh } = await supabase
            .from("messaging_jobs")
            .select("status")
            .eq("id", job.id)
            .single();
          if (!fresh || fresh.status !== "active") {
            mlog(`Job #${job.id} cancelled — stopping ${target.phone} mid-round.`);
            return;
          }
        }

        const chat = chats[i];
        const result = await sendToChat(client, chat.peer, content);
        if (result.status === "ok") {
          sent++;
        } else if (result.status === "skip") {
          skipped++;
        } else if (result.status === "flood") {
          // Whole account is rate-limited — park it and resume this round later.
          flooded = true;
          const waitSeconds = await handleTelegramRateLimit(target.phone, result.error);
          const waitMs = waitSeconds ? waitSeconds * 1000 : MESSAGING_FLOOD_DEFAULT_MS;
          const nextAt = new Date(Date.now() + waitMs).toISOString();
          await supabase
            .from("messaging_targets")
            .update({
              status: "processing",
              next_attempt_at: nextAt,
              sent_count: (target.sent_count ?? 0) + sent,
            })
            .eq("id", target.id);
          mlog(
            `Job #${job.id} · ${target.phone}: flood wait — parked ~${Math.round(
              waitMs / 60000
            )} min, will resume this round. (${sent} sent before flood)`,
            "error"
          );
          return;
        }

        if (i < chats.length - 1) await sleep(job.send_delay_ms || 1500);
      }
    } catch (err: any) {
      // Couldn't bring the account online (dead session, etc.) — fail this
      // account so the job can complete; other accounts are unaffected.
      await supabase
        .from("messaging_targets")
        .update({
          status: "failed",
          error_message: `Account error: ${err?.message || err}`,
          sent_count: (target.sent_count ?? 0) + sent,
        })
        .eq("id", target.id);
      mlog(`Job #${job.id} · ${target.phone}: account error — ${err?.message || err}`, "error");
      return;
    } finally {
      if (client) {
        try {
          await clearSession(target.phone);
        } catch {
          /* ignore */
        }
      }
    }
  });

  if (flooded) return; // already rescheduled inside the lock

  // Round finished: advance progress.
  const newSent = (target.sent_count ?? 0) + sent;
  const newRounds = round + 1;
  if (newRounds >= job.total_rounds) {
    await supabase
      .from("messaging_targets")
      .update({ status: "completed", rounds_done: newRounds, sent_count: newSent, next_attempt_at: null })
      .eq("id", target.id);
    mlog(
      `Job #${job.id} · ${target.phone}: done — ${newRounds}/${job.total_rounds} round(s), ` +
        `${newSent} total sent (${skipped} skipped this round).`,
      "success"
    );
    await maybeCompleteMessagingJob(job.id);
  } else {
    const nextAt = new Date(Date.now() + Number(job.interval_ms || 0)).toISOString();
    await supabase
      .from("messaging_targets")
      .update({ status: "processing", rounds_done: newRounds, sent_count: newSent, next_attempt_at: nextAt })
      .eq("id", target.id);
    const mins = Number(job.interval_ms || 0) / 60000;
    mlog(
      `Job #${job.id} · ${target.phone}: round ${newRounds}/${job.total_rounds} sent ` +
        `(${sent} ok, ${skipped} skipped). Next round in ~${
          mins >= 1 ? Math.round(mins) + " min" : Math.round(mins * 60) + "s"
        }.`
    );
  }
}

async function processMessagingQueue() {
  if (isProcessingMessaging) return;
  isProcessingMessaging = true;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Per-iteration guard: one transient failure or a throw from a round must
      // never kill the whole scheduler and strand the rest of the targets.
      try {
        // Only consider targets whose parent job is still active.
        const { data: activeJobs } = await supabase
          .from("messaging_jobs")
          .select("id")
          .eq("status", "active");
        const ids = (activeJobs || []).map((j: any) => j.id);
        if (!ids.length) return;

        const { data: target } = await supabase
          .from("messaging_targets")
          .select("*")
          .in("job_id", ids)
          .in("status", ["pending", "processing"])
          .order("next_attempt_at", { ascending: true, nullsFirst: true })
          .order("id", { ascending: true })
          .limit(1)
          .maybeSingle();

        if (!target) return; // nothing left to do

        const dueAt = target.next_attempt_at
          ? new Date(target.next_attempt_at).getTime()
          : 0;
        const waitMs = dueAt - Date.now();
        if (waitMs > 0) {
          await sleep(Math.min(waitMs, SCHEDULER_MAX_SLEEP_MS));
          continue;
        }

        const { data: job } = await supabase
          .from("messaging_jobs")
          .select("*")
          .eq("id", target.job_id)
          .single();
        if (!job || job.status !== "active") continue;

        await runOneMessagingRound(target, job);
        await sleep(MESSAGING_INTER_ACCOUNT_MS);
      } catch (iterErr: any) {
        mlog(
          `Messaging iteration error (continuing): ${iterErr?.message || "Unknown error"}`,
          "error"
        );
        await sleep(5000);
      }
    }
  } catch (err: any) {
    mlog(`Error in messaging scheduler: ${err?.message || "Unknown error"}`, "error");
  } finally {
    isProcessingMessaging = false;
  }
}

// Resume any in-flight messaging jobs on boot (drips can span days), and keep a
// self-healing tick so parked rounds and error-interrupted jobs are always
// re-drained without waiting for a new enqueue. Idempotent: the call is a no-op
// while a loop is already running.
export function startMessagingProcessor() {
  processMessagingQueue();
  setInterval(() => processMessagingQueue(), QUEUE_TICK_MS).unref?.();
}

// ----- Messaging endpoints -------------------------------------------------

// Normalize a body field that may arrive as a real value (JSON request) or a
// string (multipart request from express-fileupload).
function asArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// POST /messaging/messages/preview — generate an AI message pool the user can
// review/edit before launching a drip. One Groq call.
router.post("/messaging/messages/preview", async (req: Request, res: Response) => {
  try {
    const { theme } = req.body;
    const count = Math.max(1, Math.min(200, Number(req.body.count) || 1));
    if (!theme || typeof theme !== "string") {
      return res.status(400).json({ success: false, error: "A theme is required." });
    }
    const messages = await generateBroadcastMessages(theme, count);
    return res.json({ success: true, data: { messages } });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Failed to generate messages." });
  }
});

// POST /messaging/jobs — create a broadcast or drip job.
// Accepts JSON, or multipart/form-data when a broadcast image is attached.
router.post("/messaging/jobs", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const body = req.body || {};

    const mode = body.mode === "drip" ? "drip" : body.mode === "broadcast" ? "broadcast" : null;
    const targetKind: TargetKind =
      body.targetKind === "channel" ? "channel" : body.targetKind === "group" ? "group" : "group";
    if (!mode) {
      return res.status(400).json({ success: false, error: "mode must be 'broadcast' or 'drip'." });
    }
    if (body.targetKind !== "channel" && body.targetKind !== "group") {
      return res.status(400).json({ success: false, error: "targetKind must be 'channel' or 'group'." });
    }

    const accounts = asArray(body.accounts).filter((p) => typeof p === "string");
    if (!accounts.length) {
      return res.status(400).json({ success: false, error: "Select at least one account." });
    }

    // Only allow accounts owned by this workspace.
    const { data: owned } = await supabase
      .from("telegram_accounts")
      .select("phone")
      .eq("workspace", ws)
      .in("phone", accounts);
    const ownedPhones = new Set((owned || []).map((a: any) => a.phone));
    const phones = accounts.filter((p) => ownedPhones.has(p));
    if (!phones.length) {
      return res.status(404).json({ success: false, error: "None of the selected accounts were found." });
    }

    // Build the job row per mode.
    let jobRow: any = {
      workspace: ws,
      mode,
      target_kind: targetKind,
      status: "active",
      send_delay_ms: Math.max(500, Math.min(10000, Number(body.sendDelayMs) || 1500)),
      created_at: new Date().toISOString(),
    };

    const imageFile: any = (req as any).files?.image;

    if (mode === "broadcast") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const caption = typeof body.caption === "string" ? body.caption.trim() : "";
      if (!imageFile && !text) {
        return res
          .status(400)
          .json({ success: false, error: "Provide a message or an image." });
      }
      jobRow = {
        ...jobRow,
        total_rounds: 1,
        span_days: 0,
        interval_ms: 0,
        message_pool: text ? [text] : null,
        caption: imageFile ? caption || null : null,
      };
    } else {
      // drip
      const total = Math.max(1, Math.min(200, Number(body.messagesPerChat) || 1));
      const spanDays = Math.max(0.001, Math.min(60, Number(body.spanDays) || 1));
      const theme = typeof body.theme === "string" ? body.theme.trim() : "";
      const edited = asArray(body.messages).filter((m) => typeof m === "string" && m.trim());

      let pool: string[];
      if (edited.length) {
        pool = edited.slice(0, total);
        while (pool.length < total) pool.push(pool[pool.length % Math.max(1, edited.length)]);
      } else {
        if (!theme) {
          return res
            .status(400)
            .json({ success: false, error: "Provide a theme or an edited message list." });
        }
        pool = await generateBroadcastMessages(theme, total);
      }

      jobRow = {
        ...jobRow,
        total_rounds: total,
        span_days: spanDays,
        interval_ms: Math.floor((spanDays * 86400000) / total),
        message_pool: pool,
        theme: theme || null,
      };
    }

    const { data: job, error: jobError } = await supabase
      .from("messaging_jobs")
      .insert(jobRow)
      .select()
      .single();
    if (jobError || !job) {
      return res
        .status(500)
        .json({ success: false, error: `Failed to create job: ${jobError?.message}` });
    }

    // Persist a broadcast image now that we have the job id.
    if (mode === "broadcast" && imageFile) {
      const ext = (path.extname(imageFile.name || "") || ".jpg").slice(0, 5);
      const dest = path.join(UPLOADS_DIR, `${job.id}${ext}`);
      try {
        await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
        await fs.promises.writeFile(dest, imageFile.data);
        await supabase.from("messaging_jobs").update({ image_path: dest }).eq("id", job.id);
        job.image_path = dest;
      } catch (err: any) {
        await supabase.from("messaging_jobs").delete().eq("id", job.id);
        return res
          .status(500)
          .json({ success: false, error: `Failed to store image: ${err?.message || err}` });
      }
    }

    // One target row per account.
    const targetRows = phones.map((phone) => ({ job_id: job.id, phone, status: "pending" }));
    const { error: targetError } = await supabase.from("messaging_targets").insert(targetRows);
    if (targetError) {
      await supabase.from("messaging_jobs").delete().eq("id", job.id);
      cleanupJobImage(job);
      return res
        .status(500)
        .json({ success: false, error: `Failed to create targets: ${targetError.message}` });
    }

    mlog(
      `Messaging job #${job.id} created: ${mode} to ${targetKind}s across ${phones.length} account(s)` +
        (mode === "drip" ? ` — ${jobRow.total_rounds} msg/chat over ${jobRow.span_days} day(s).` : "."),
      "info"
    );

    processMessagingQueue();
    return res.json({ success: true, data: { job_id: job.id } });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Unexpected error." });
  }
});

// GET /messaging/jobs — list jobs with per-account progress. Shared across users
// (like the console log), so both workspaces see every messaging job. `is_owner`
// tells the UI which jobs the caller may cancel.
router.get("/messaging/jobs", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { data: jobs, error } = await supabase
      .from("messaging_jobs")
      .select("*, targets:messaging_targets(*)")
      .order("created_at", { ascending: false });
    if (error) {
      return res.status(500).json({ success: false, error: `Failed to list jobs: ${error.message}` });
    }
    const withOwner = (jobs || []).map((j: any) => ({
      ...j,
      is_owner: (j.workspace || "default") === ws,
    }));
    return res.json({ success: true, data: withOwner });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || "Unexpected error." });
  }
});

// DELETE /messaging/jobs/:id — cancel a job (scheduler skips non-active jobs).
router.delete("/messaging/jobs/:id", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);
    const { id } = req.params;
    // Everyone can SEE every job, but only the owner may cancel it.
    const { data: job } = await supabase
      .from("messaging_jobs")
      .select("*")
      .eq("id", id)
      .single();
    if (!job) {
      return res.status(404).json({ success: false, error: "Job not found." });
    }
    if ((job.workspace || "default") !== ws) {
      return res
        .status(403)
        .json({ success: false, error: "Only the owner can cancel this job." });
    }
    await supabase
      .from("messaging_jobs")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", id);
    cleanupJobImage(job);
    return res.json({ success: true, message: `Job ${id} cancelled.` });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || "Unexpected error." });
    }
  });

// GET /stats/overall — aggregate stats across ALL workspaces (admin/overview view)
router.get("/stats/overall", async (_req: Request, res: Response) => {
  try {
    // Accounts across all workspaces
    const { data: accounts, error: accError } = await supabase
      .from("telegram_accounts")
      .select("phone, username, groups_count, channels_count, bots_count, bots_created_24h, bots_next_reset, default_bots_count, crypto_bots_count, groups_created_24h, next_available_time, flood_wait_until");
    if (accError) throw accError;

    // Bots across all workspaces
    const { data: bots, error: botError } = await supabase
      .from("telegram_bots")
      .select("id, username, display_name, owner_phone, theme, created_at");
    if (botError) throw botError;

    // Queue jobs across all workspaces
    const { data: queue, error: queueError } = await supabase
      .from("group_creation_queue")
      .select("*")
      .order("created_at", { ascending: false });
    if (queueError) throw queueError;

    // Messaging jobs across all workspaces
    const { data: jobs, error: jobsError } = await supabase
      .from("messaging_jobs")
      .select("*, targets:messaging_targets(*)")
      .order("created_at", { ascending: false });
    if (jobsError) throw jobsError;

    // Compute aggregates
    const channels = accounts?.reduce((s, a) => s + (a.channels_count || 0), 0) || 0;
    const groups = accounts?.reduce((s, a) => s + Math.max(0, (a.groups_count || 0) - (a.channels_count || 0)), 0) || 0;
    const botsTotal = (bots?.length || 0) || accounts?.reduce((s, a) => s + (a.bots_count || 0), 0) || 0;
    const sent = jobs?.reduce((s, j) => s + j.targets.reduce((t: number, x: { sent_count?: number }) => t + (x.sent_count || 0), 0), 0) || 0;
    const queueActive = queue?.filter((j) => j.status === 'pending' || j.status === 'processing').length || 0;
    const activeJobs = queueActive + (jobs?.filter((j) => j.status === 'active').length || 0);

    return res.json({
      success: true,
      data: {
        accounts: accounts?.length || 0,
        groups,
        channels,
        botsTotal,
        sent,
        activeJobs,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || "Failed to fetch overall stats" });
  }
});

// GET /stats — combined workspace + overall stats in a single call
// Workspace-scoped (uses workspace header), overall is global (all workspaces)
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const ws = getWorkspace(req);

    // Workspace-scoped accounts
    const { data: wsAccounts, error: wsAccError } = await supabase
      .from("telegram_accounts")
      .select("phone, username, groups_count, channels_count, bots_count, bots_created_24h, bots_next_reset, default_bots_count, crypto_bots_count, groups_created_24h, next_available_time, flood_wait_until")
      .eq("workspace", ws);
    if (wsAccError) throw wsAccError;

    // Workspace-scoped bots
    const { data: wsBots, error: wsBotError } = await supabase
      .from("telegram_bots")
      .select("id, username, display_name, owner_phone, theme, created_at")
      .eq("workspace", ws);
    if (wsBotError) throw wsBotError;

    // Workspace-scoped queue jobs
    const { data: wsQueue, error: wsQueueError } = await supabase
      .from("group_creation_queue")
      .select("*")
      .eq("workspace", ws)
      .order("created_at", { ascending: false });
    if (wsQueueError) throw wsQueueError;

    // Workspace-scoped messaging jobs
    const { data: wsJobs, error: wsJobsError } = await supabase
      .from("messaging_jobs")
      .select("*, targets:messaging_targets(*)")
      .eq("workspace", ws)
      .order("created_at", { ascending: false });
    if (wsJobsError) throw wsJobsError;

    // Overall (all workspaces) accounts
    const { data: allAccounts, error: allAccError } = await supabase
      .from("telegram_accounts")
      .select("phone, username, groups_count, channels_count, bots_count, bots_created_24h, bots_next_reset, default_bots_count, crypto_bots_count, groups_created_24h, next_available_time, flood_wait_until");
    if (allAccError) throw allAccError;

    // Overall bots
    const { data: allBots, error: allBotError } = await supabase
      .from("telegram_bots")
      .select("id, username, display_name, owner_phone, theme, created_at");
    if (allBotError) throw allBotError;

    // Overall queue jobs
    const { data: allQueue, error: allQueueError } = await supabase
      .from("group_creation_queue")
      .select("*")
      .order("created_at", { ascending: false });
    if (allQueueError) throw allQueueError;

    // Overall messaging jobs
    const { data: allJobs, error: allJobsError } = await supabase
      .from("messaging_jobs")
      .select("*, targets:messaging_targets(*)")
      .order("created_at", { ascending: false });
    if (allJobsError) throw allJobsError;

    // Workspace aggregates
    const wsChannels = wsAccounts?.reduce((s, a) => s + (a.channels_count || 0), 0) || 0;
    const wsGroups = wsAccounts?.reduce((s, a) => s + Math.max(0, (a.groups_count || 0) - (a.channels_count || 0)), 0) || 0;
    const wsBotsTotal = (wsBots?.length || 0) || wsAccounts?.reduce((s, a) => s + (a.bots_count || 0), 0) || 0;
    const wsSent = wsJobs?.reduce((s, j) => s + j.targets.reduce((t: number, x: { sent_count?: number }) => t + (x.sent_count || 0), 0), 0) || 0;
    const wsQueueActive = wsQueue?.filter((j) => j.status === 'pending' || j.status === 'processing').length || 0;
    const wsActiveJobs = wsQueueActive + (wsJobs?.filter((j) => j.status === 'active').length || 0);

    // Overall aggregates
    const allChannels = allAccounts?.reduce((s, a) => s + (a.channels_count || 0), 0) || 0;
    const allGroups = allAccounts?.reduce((s, a) => s + Math.max(0, (a.groups_count || 0) - (a.channels_count || 0)), 0) || 0;
    const allBotsTotal = (allBots?.length || 0) || allAccounts?.reduce((s, a) => s + (a.bots_count || 0), 0) || 0;
    const allSent = allJobs?.reduce((s, j) => s + j.targets.reduce((t: number, x: { sent_count?: number }) => t + (x.sent_count || 0), 0), 0) || 0;
    const allQueueActive = allQueue?.filter((j) => j.status === 'pending' || j.status === 'processing').length || 0;
    const allActiveJobs = allQueueActive + (allJobs?.filter((j) => j.status === 'active').length || 0);

    return res.json({
      success: true,
      data: {
        workspace: {
          groups: wsGroups,
          channels: wsChannels,
          botsTotal: wsBotsTotal,
          sent: wsSent,
          activeJobs: wsActiveJobs,
        },
        overall: {
          accounts: allAccounts?.length || 0,
          groups: allGroups,
          channels: allChannels,
          botsTotal: allBotsTotal,
          sent: allSent,
          activeJobs: allActiveJobs,
        },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || "Failed to fetch stats" });
  }
});

export default router;
