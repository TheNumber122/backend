import { Conversation } from "@mtcute/node";

// Automates @BotFather over a user session to create a bot. One call = one
// /newbot cycle. Because BotFather keeps asking for a username after a rejected
// one, a single cycle can try the whole candidate pool until one sticks.

const BOTFATHER = "botfather";
const STEP_TIMEOUT = 30000; // ms to wait for each BotFather reply
const SEND_DELAY = 2000; // ms between our messages (look human, avoid flood)

export type BotFatherResult =
  | { ok: true; token: string; username: string; tried: string[] }
  | {
      ok: false;
      reason: "limit" | "flood" | "no_username" | "error";
      message: string;
      tried: string[];
    };

const TOKEN_RE = /(\d{8,10}:[A-Za-z0-9_-]{35})/;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function classifyUsernameReply(text: string): "success" | "taken" | "invalid" | "limit" | "flood" | "unknown" {
  if (TOKEN_RE.test(text)) return "success";
  const t = text.toLowerCase();
  if (/already taken|is already in use/.test(t)) return "taken";
  if (/too many bots|maximum number of bots|20 bots/.test(t)) return "limit";
  if (/too many attempts|try again later|flood/.test(t)) return "flood";
  if (/invalid|i don'?t like|too short|too long|must end|username must|not a valid/.test(t))
    return "invalid";
  return "unknown";
}

// Detect a blocker on the reply to /newbot or to the display name (before we
// even get to choose a username).
function classifyPreUsernameReply(text: string): "ask_username" | "ask_name" | "limit" | "flood" | "unknown" {
  const t = text.toLowerCase();
  if (/too many bots|maximum number of bots|20 bots/.test(t)) return "limit";
  if (/too many attempts|try again later|flood/.test(t)) return "flood";
  if (/username/.test(t)) return "ask_username";
  if (/name/.test(t)) return "ask_name";
  return "unknown";
}

export async function createBotViaBotFather(
  client: any,
  displayName: string,
  candidates: string[]
): Promise<BotFatherResult> {
  const tried: string[] = [];
  const conv = new Conversation(client, BOTFATHER);

  return conv.with(async () => {
    // 1. Kick off a new bot.
    await conv.sendText("/newbot");
    let reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
    let stage = classifyPreUsernameReply(reply.text);
    if (stage === "limit") return { ok: false, reason: "limit", message: reply.text, tried };
    if (stage === "flood") return { ok: false, reason: "flood", message: reply.text, tried };

    // 2. Provide the display name (BotFather then asks for a username).
    await sleep(SEND_DELAY);
    await conv.sendText(displayName);
    reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
    stage = classifyPreUsernameReply(reply.text);
    if (stage === "limit") return { ok: false, reason: "limit", message: reply.text, tried };
    if (stage === "flood") return { ok: false, reason: "flood", message: reply.text, tried };

    // 3. Try usernames until one is accepted or we run out.
    for (const username of candidates) {
      tried.push(username);
      await sleep(SEND_DELAY);
      await conv.sendText(username);
      reply = await conv.waitForResponse(undefined, { timeout: STEP_TIMEOUT });
      const verdict = classifyUsernameReply(reply.text);

      if (verdict === "success") {
        const token = reply.text.match(TOKEN_RE)?.[1] ?? "";
        return { ok: true, token, username, tried };
      }
      if (verdict === "limit") return { ok: false, reason: "limit", message: reply.text, tried };
      if (verdict === "flood") return { ok: false, reason: "flood", message: reply.text, tried };
      // taken / invalid / unknown → BotFather is still waiting; try next candidate.
    }

    return { ok: false, reason: "no_username", message: "All candidate usernames were rejected", tried };
  });
}
