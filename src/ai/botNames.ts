import { supabase } from "../db/supabase";
import { generateBotUsernames, GenMode } from "./groq";

// Persistent bot-name reservoir backed by the `bot_name_pool` table.
// Draws claim `free` rows via an atomic lease (claim_bot_names). Groq is called
// only when the pool is fully drained, in one tool-less batch of BUFFER names.
// Every DB call degrades to direct generation on failure, so the pipeline never
// crashes and works even before the migration is applied.

// ponytail: refill only when the pool can't fill this request, so a drained pool
// makes the requesting job pay the Groq latency (and get a short draw if Groq is
// in 429 cooldown). Add a background top-up if that stall ever matters.
const BUFFER = 300;

type Emit = (message: string) => void;
const emitOf = (log?: Emit): Emit => log ?? ((m) => console.log(m));

// PostgREST returns a scalar setof either as ["a","b"] or [{col:"a"},...] across
// versions — accept both plus an explicit `username` key.
export function extractNames(data: any): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") {
        if (typeof r.username === "string") return r.username;
        const first = Object.values(r)[0];
        if (typeof first === "string") return first;
      }
      return "";
    })
    .filter(Boolean);
}

export async function getBotUsernames(
  count: number,
  opts: { mode?: GenMode; theme?: string; avoid?: string[]; log?: Emit }
): Promise<string[]> {
  const { mode = "default", theme, avoid = [], log } = opts;
  const emit = emitOf(log);
  const p_theme = theme ?? null;

  try {
    const { data: freeData, error: cErr } = await supabase.rpc("count_free_bot_names", {
      p_mode: mode,
      p_theme,
    });
    if (cErr) throw cErr;
    const free = Number(freeData) || 0;

    if (free < count) {
      emit(`[pool] mode=${mode} free=${free}<${count} — refilling ${BUFFER}`);
      const fresh = await generateBotUsernames({ count: BUFFER, mode, theme, log: emit });
      if (fresh.length) {
        const rows = fresh.map((username) => ({ username, mode, theme: p_theme, status: "free" }));
        const { error: upErr } = await supabase
          .from("bot_name_pool")
          .upsert(rows, { onConflict: "username", ignoreDuplicates: true });
        if (upErr) emit(`[pool] refill insert failed: ${upErr.message}`);
        else emit(`[pool] refill mode=${mode} +${fresh.length} candidates`);
      }
    }

    const { data: claimed, error: clErr } = await supabase.rpc("claim_bot_names", {
      p_mode: mode,
      p_theme,
      p_count: count,
    });
    if (clErr) throw clErr;

    const avoidSet = new Set(avoid);
    const out = extractNames(claimed).filter((n) => !avoidSet.has(n));
    emit(`[pool] claim mode=${mode} got=${out.length}/${count} (free was ${free})`);
    return out;
  } catch (err) {
    emit(`[pool] db unavailable, generating directly: ${(err as Error)?.message ?? err}`);
    return generateBotUsernames({ count, mode, theme, avoid, log: emit });
  }
}

export async function markTried(
  handles: string[],
  opts: { mode?: GenMode; theme?: string }
): Promise<void> {
  if (!handles.length) return;
  const { mode = "default", theme } = opts;
  const rows = handles.map((username) => ({
    username,
    mode,
    theme: theme ?? null,
    status: "dead",
  }));
  const { error } = await supabase.from("bot_name_pool").upsert(rows, { onConflict: "username" });
  if (error) console.log(`[pool] markTried failed: ${error.message}`);
}
