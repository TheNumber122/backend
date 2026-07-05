// Send one message (text, or image+caption) to a single chat, classifying the
// outcome so the messaging scheduler can react:
//   • 'ok'    → delivered
//   • 'skip'  → this chat rejected us (write-forbidden, private, banned, …);
//               harmless, just move on to the next chat.
//   • 'flood' → Telegram FLOOD_WAIT; the whole account must back off. The error
//               is returned so the caller can park the account via
//               handleTelegramRateLimit().

import { TelegramClient } from "@mtcute/node";

export type TextContent = { kind: "text"; text: string };
export type PhotoContent = { kind: "photo"; file: Buffer; caption?: string };
export type SendContent = TextContent | PhotoContent;

export type SendResult =
  | { status: "ok" }
  | { status: "skip"; reason: string }
  | { status: "flood"; error: any };

// Peer is the mtcute Chat object captured during discovery (carries access_hash).
export async function sendToChat(
  client: TelegramClient,
  peer: any,
  content: SendContent
): Promise<SendResult> {
  try {
    if (content.kind === "photo") {
      await client.sendMedia(peer, {
        type: "photo",
        file: content.file,
        caption: content.caption,
      });
    } else {
      await client.sendText(peer, content.text);
    }
    return { status: "ok" };
  } catch (err: any) {
    const msg = String(err?.message || err);

    // Real flood wait → the account itself is rate-limited; bubble up.
    if (/FLOOD_WAIT_\d+|flood wait|wait of \d+ seconds/i.test(msg)) {
      return { status: "flood", error: err };
    }

    // Everything else is a per-chat problem (can't post here, left the chat,
    // banned, deleted, slow-mode, etc.) — skip this chat, keep the job going.
    return { status: "skip", reason: msg };
  }
}
