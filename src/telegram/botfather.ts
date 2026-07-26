import { Conversation, BotKeyboard } from "@mtcute/node";

// Automates @BotFather over a user session to create a bot. One call = one
// /newbot cycle. Because BotFather keeps asking for a username after a rejected
// one, a single cycle can try the whole candidate pool until one sticks.
//
// IMPORTANT: this relies on the client's updates loop being ACTIVE so that
// `waitForResponse` actually receives BotFather's replies. Sessions restored
// from a session string do NOT auto-start the loop — the caller must call
// `client.startUpdatesLoop()` first (see createBotsInner in routes.ts).

const BOTFATHER = "botfather";
const STEP_TIMEOUT = 45000; // ms to wait for each BotFather reply
const SEND_DELAY = 800; // ms between our messages (small gap; daily cap is the real guard)

export type LogFn = (message: string, type?: "info" | "success" | "error") => void;

export type BotFatherResult =
  | { ok: true; token: string; username: string; tried: string[] }
  | {
      ok: false;
      reason: "limit" | "flood" | "timeout" | "no_username" | "error";
      message: string;
      tried: string[];
      // For "flood": the exact number of seconds BotFather told us to wait, if it
      // gave one (e.g. "try again in 129 seconds"). undefined = no number parsed.
      retryAfter?: number;
    };

const TOKEN_RE = /(\d{8,10}:[A-Za-z0-9_-]{35})/;

// BotFather flood replies often name a delay, e.g.
//   "Sorry, too many attempts. Please try again in 129 seconds."
//   "...try again in 5 minutes."
// Pull that out so the scheduler can wait the exact time instead of a blind 30m.
function parseRetrySeconds(text: string): number | undefined {
  const t = (text || "").toLowerCase();
  const m = t.match(/try again in (\d+)\s*(second|minute|hour)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2];
  if (unit === "hour") return n * 3600;
  if (unit === "minute") return n * 60;
  return n;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Collapse whitespace and truncate a BotFather reply for logging.
function short(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function isTimeoutErr(e: any): boolean {
  const m = String(e?.name || "") + " " + String(e?.message || e || "");
  return /timeout/i.test(m);
}

function classifyUsernameReply(
  text: string
): "success" | "taken" | "invalid" | "limit" | "flood" | "unknown" {
  if (TOKEN_RE.test(text)) return "success";
  const t = text.toLowerCase();
  if (/already taken|is already in use|already exists/.test(t)) return "taken";
  if (
    /too many bots|maximum number of bots|(can'?t|cannot) add more than|delete one of your bots|20 bots|40 bots/.test(
      t
    )
  )
    return "limit";
  if (/too many attempts|try again later|flood/.test(t)) return "flood";
  if (
    /invalid|i don'?t like|too short|too long|must end|username must|not a valid|can't use|sorry, this username/.test(
      t
    )
  )
    return "invalid";
  return "unknown";
}

function classifyPreUsernameReply(
  text: string
): "ask_username" | "ask_name" | "limit" | "flood" | "unknown" {
  const t = text.toLowerCase();
  if (
    /too many bots|maximum number of bots|(can'?t|cannot) add more than|delete one of your bots|20 bots|40 bots/.test(
      t
    )
  )
    return "limit";
  if (/too many attempts|try again later|flood/.test(t)) return "flood";
  if (/username/.test(t)) return "ask_username";
  if (/name/.test(t)) return "ask_name";
  return "unknown";
}

export async function createBotViaBotFather(
  client: any,
  displayName: string,
  candidates: string[],
  log: LogFn
): Promise<BotFatherResult> {
  const tried: string[] = [];
  const conv = new Conversation(client, BOTFATHER);

  try {
    return await conv.with(async () => {
      // 1. Kick off a new bot.
      log("BotFather → /newbot");
      await conv.sendText("/newbot");
      let reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      log(`BotFather ⇐ ${short(reply.text)}`);
      let stage = classifyPreUsernameReply(reply.text);
      if (stage === "limit") return { ok: false, reason: "limit", message: reply.text, tried };
      if (stage === "flood")
        return {
          ok: false,
          reason: "flood",
          message: reply.text,
          tried,
          retryAfter: parseRetrySeconds(reply.text),
        };

      // 2. Provide the display name (BotFather then asks for a username).
      log(`BotFather → name: "${displayName}"`);
      await sleep(SEND_DELAY);
      await conv.sendText(displayName);
      reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      log(`BotFather ⇐ ${short(reply.text)}`);
      stage = classifyPreUsernameReply(reply.text);
      if (stage === "limit") return { ok: false, reason: "limit", message: reply.text, tried };
      if (stage === "flood")
        return {
          ok: false,
          reason: "flood",
          message: reply.text,
          tried,
          retryAfter: parseRetrySeconds(reply.text),
        };

      // 3. Try usernames until one is accepted or we run out.
      for (const username of candidates) {
        tried.push(username);
        log(`BotFather → username: @${username}`);
        await sleep(SEND_DELAY);
        await conv.sendText(username);
        reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
        log(`BotFather ⇐ ${short(reply.text)}`);
        const verdict = classifyUsernameReply(reply.text);

        if (verdict === "success") {
          const token = reply.text.match(TOKEN_RE)?.[1] ?? "";
          return { ok: true, token, username, tried };
        }
        if (verdict === "limit") return { ok: false, reason: "limit", message: reply.text, tried };
        if (verdict === "flood")
          return {
            ok: false,
            reason: "flood",
            message: reply.text,
            tried,
            retryAfter: parseRetrySeconds(reply.text),
          };
        // taken / invalid / unknown → BotFather still waits; try next candidate.
      }

      return {
        ok: false,
        reason: "no_username",
        message: "All candidate usernames were rejected",
        tried,
      };
    });
  } catch (err: any) {
    const message = String(err?.message || err);
    if (isTimeoutErr(err)) {
      log(
        `BotFather: timed out after ${STEP_TIMEOUT / 1000}s waiting for a reply — ` +
          `the account may not be receiving updates. (${message})`,
        "error"
      );
      return { ok: false, reason: "timeout", message, tried };
    }
    log(`BotFather: conversation error — ${message}`, "error");
    return { ok: false, reason: "error", message, tried };
  }
}

// ---------------------------------------------------------------------------
// Mass bot deletion via BotFather conversation.
//
// Flow:
//   1. /mybots → list of bots (inline keyboard, 6 per page)
//   2. Click the target bot → action menu
//   3. Click "Delete Bot" → first confirmation
//   4. Click button containing "Yes" → second confirmation
//   5. Click button containing "Yes" → done
//
// Inline buttons are clicked via client.getCallbackAnswer() (user-only method).
// BotFather doesn't always answer callback queries, so we use fireAndForget
// and rely on waitForResponse to get the next message.
// ---------------------------------------------------------------------------

export type DeleteBotResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "flood" | "timeout" | "error"; message: string };

// Find a callback button whose text contains `substring` (case-insensitive).
function findButtonContaining(
  buttons: any[][],
  substring: string
): any | null {
  for (const row of buttons) {
    for (const btn of row) {
      if (
        btn._ === "keyboardButtonCallback" &&
        typeof btn.text === "string" &&
        btn.text.toLowerCase().includes(substring.toLowerCase())
      ) {
        return btn;
      }
    }
  }
  return null;
}

// Click an inline button via getCallbackAnswer, fire-and-forget style.
async function clickInlineButton(client: any, msg: any, btn: any): Promise<void> {
  try {
    await client.getCallbackAnswer({
      message: msg,
      data: btn.data,
      fireAndForget: true,
      timeout: 10000,
    });
  } catch {
    // Fire-and-forget: errors are non-fatal, we wait for the next message anyway.
  }
}

// Safely extract inline keyboard buttons from a message's markup.
function getInlineButtons(msg: any): any[][] {
  const m = msg?.markup;
  if (m && m.type === "inline" && Array.isArray(m.buttons)) return m.buttons;
  return [];
}

export async function deleteBotViaBotFather(
  client: any,
  botUsername: string, // without @
  log: LogFn
): Promise<DeleteBotResult> {
  const conv = new Conversation(client, BOTFATHER);
  const usernameLower = botUsername.toLowerCase();

  try {
    return await conv.with(async () => {
      // Step 1: /mybots
      log("BotFather → /mybots");
      await conv.sendText("/mybots");
      let reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      log(`BotFather ⇐ ${short(reply.text)}`);

      // Step 2: Find the bot in the list (paginate if needed)
      const found = await findBotInList(client, conv, reply, usernameLower, log);
      if (!found) {
        return { ok: false, reason: "not_found", message: `@${botUsername} not found in /mybots list` };
      }

      const { msg: listMsg, btn: botBtn } = found;

      // Step 3: Click on the bot
      log(`BotFather → click @${botUsername}`);
      await clickInlineButton(client, listMsg, botBtn);
      reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      log(`BotFather ⇐ ${short(reply.text)}`);

      // Step 4: Click "Delete Bot"
      const deleteBtn = findButtonContaining(getInlineButtons(reply), "Delete Bot");
      if (!deleteBtn) {
        log("BotFather: could not find 'Delete Bot' button in action menu", "error");
        return { ok: false, reason: "error", message: "Delete Bot button not found" };
      }

      log("BotFather → click Delete Bot");
      await clickInlineButton(client, reply, deleteBtn);
      reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      log(`BotFather ⇐ ${short(reply.text)}`);

      // Step 5: First confirmation — find button containing "Yes"
      let yesBtn = findButtonContaining(getInlineButtons(reply), "Yes");
      if (!yesBtn) {
        log("BotFather: could not find 'Yes' button in first confirmation", "error");
        return { ok: false, reason: "error", message: "First confirmation button not found" };
      }

      log(`BotFather → click "${yesBtn.text}"`);
      await clickInlineButton(client, reply, yesBtn);
      reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      log(`BotFather ⇐ ${short(reply.text)}`);

      // Step 6: Second confirmation — find button containing "Yes"
      yesBtn = findButtonContaining(getInlineButtons(reply), "Yes");
      if (!yesBtn) {
        log("BotFather: could not find 'Yes' button in second confirmation", "error");
        return { ok: false, reason: "error", message: "Second confirmation button not found" };
      }

      log(`BotFather → click "${yesBtn.text}"`);
      await clickInlineButton(client, reply, yesBtn);
      reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      log(`BotFather ⇐ ${short(reply.text)}`);

      // Check if deletion was successful
      const replyText = (reply.text || "").toLowerCase();
      if (replyText.includes("deleted") || replyText.includes("done") || replyText.includes("success")) {
        log(`Bot @${botUsername} deleted successfully.`, "success");
        return { ok: true };
      }

      // Could be a flood or unexpected response
      if (/too many attempts|try again|flood/.test(replyText)) {
        const retryAfter = parseRetrySeconds(reply.text);
        log(`BotFather flood during deletion: ${reply.text}`, "error");
        return { ok: false, reason: "flood", message: reply.text };
      }

      // Assume success if BotFather responded with something non-error
      log(`Bot @${botUsername} deletion completed.`, "success");
      return { ok: true };
    });
  } catch (err: any) {
    const message = String(err?.message || err);
    if (isTimeoutErr(err)) {
      log(`BotFather: timed out during deletion of @${botUsername} — ${message}`, "error");
      return { ok: false, reason: "timeout", message };
    }
    log(`BotFather: deletion error for @${botUsername} — ${message}`, "error");
    return { ok: false, reason: "error", message };
  }
}

// Search through /mybots pages to find the target bot.
// Handles pagination via the "»" button.
async function findBotInList(
  client: any,
  conv: any,
  reply: any,
  usernameLower: string,
  log: LogFn
): Promise<{ msg: any; btn: any } | null> {
  for (let page = 0; page < 10; page++) {
    const buttons = getInlineButtons(reply);
    if (buttons.length) {
      // Check each button for the target username
      for (const row of buttons) {
        for (const btn of row) {
          if (
            btn._ === "keyboardButtonCallback" &&
            typeof btn.text === "string" &&
            btn.text.toLowerCase().includes(usernameLower)
          ) {
            return { msg: reply, btn };
          }
        }
      }
    }

    // Not found on this page — try clicking "»" for next page
    const nextBtn = findButtonContaining(buttons, "»");
    if (!nextBtn) return null; // no more pages

    log(`BotFather → click » (page ${page + 2})`);
    await clickInlineButton(client, reply, nextBtn);
    await sleep(2000);
    reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
    log(`BotFather ⇐ ${short(reply.text)}`);
  }
  return null;
}
