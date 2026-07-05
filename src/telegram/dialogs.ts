// Live discovery of the channels/groups an account already belongs to.
//
// This project stores NO chat IDs — accounts created their channels/groups
// long ago and we only keep aggregate counters. So to "send to all channels"
// or "all groups" we ask Telegram directly via iterDialogs() and filter by
// chat type each time we need the list.

import { TelegramClient } from "@mtcute/node";

export type TargetKind = "channel" | "group";

export interface DiscoveredChat {
  id: number; // bare Telegram chat id (for logging / counting)
  title: string;
  peer: any; // the mtcute Chat object — pass straight to send methods so the
  // cached access_hash is used (avoids marked/bare id resolution issues).
}

// Iterate the account's dialogs and return the ones matching `kind`:
//   • channel → broadcast channels (chatType 'channel')
//   • group   → megagroups/supergroups/basic groups (Chat.isGroup)
// Users/bots and the other kind are skipped. Safe: swallows iteration errors
// and returns whatever was gathered so a single bad dialog can't abort a job.
export async function listChatsForAccount(
  client: TelegramClient,
  kind: TargetKind
): Promise<DiscoveredChat[]> {
  const out: DiscoveredChat[] = [];

  try {
    for await (const dialog of client.iterDialogs({ archived: "keep" })) {
      const peer: any = dialog.peer;
      if (!peer || peer.type !== "chat") continue; // skip users/bots

      const isChannel = peer.chatType === "channel"; // broadcast only
      const isGroup =
        peer.chatType === "group" ||
        peer.chatType === "supergroup" ||
        peer.chatType === "gigagroup";

      const matches = kind === "channel" ? isChannel : isGroup;
      if (!matches) continue;

      out.push({ id: peer.id, title: peer.title || String(peer.id), peer });
    }
  } catch {
    // Return what we have — the caller logs the count and proceeds.
  }

  return out;
}
