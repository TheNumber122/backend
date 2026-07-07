// Cerebras-backed generator for Telegram bot usernames. Handles are built from one
// or two short, real, common English words ending in "bot"; crypto mode prefixes
// "crypto", default mode is just the word(s) + "bot". NO numbers, NO underscores.
// AI-only: there is NO local fallback. To fight repetition cheaply, each call
// forces the first word to start with the next letter in a rotating consonant
// sweep (counter-driven, not random) — so back-to-back batches can't cluster on
// the same over-farmed words, and we spend no prompt tokens listing rejected names.
//
// Cerebras is OpenAI-compatible; we moved off Groq because its free tier ran out
// of daily requests. Free tier here: 1M tokens/day, 30 req/min (reset 00:00 UTC).

const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = "gpt-oss-120b";

type GenMode = "default" | "crypto" | "custom";

interface GenerateOpts {
  count: number;
  theme?: string; // custom-pattern theme, e.g. "must be about crypto"
  avoid?: string[]; // handles already tried this run (skip duplicates)
  mode?: GenMode; // 'crypto' forces start-with-"crypto", end-with bot/robot
}

// How many extra candidates to request beyond `count`, so a few "username taken"
// collisions are covered by a single AI call instead of many.
const BUFFER = 5;

// NOTE: `avoid` is used ONLY to de-dupe the OUTPUT (the `skip` Set in
// callCerebrasOnce) — it is deliberately NOT pasted into the prompt. The rotating
// letter constraint (see nextLetter) spreads batches apart without spending
// tokens narrating rejected names, which used to be the biggest cost driver.

// Hard cap on the "word id" portion of the handle — i.e. everything except the
// literal "crypto" prefix (crypto mode) and the "bot" suffix. Enforced here in
// code, not just in the prompt, because the model doesn't always respect
// length instructions (it sometimes truncates/glues words to force a fit,
// e.g. "lanthem", "pilobot" — this cap + the sanitize check below stop that).
const MAX_WORD_LEN = 8;
const MIN_WORD_LEN = 3;

function capitalizeFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Counter-driven letter sweep: each Cerebras call forces the first word to start
// with the next consonant here, so consecutive batches can't collide on the same
// over-farmed words. Deterministic (not random) so we cover the space instead of
// re-landing on the same cluster; vowels and q/x/y/z are dropped because too few
// short, common words start with them.
const START_LETTERS = "bcdfghjklmnprstvw".split("");
let letterCursor = 0;
function nextLetter(): string {
  const letter = START_LETTERS[letterCursor % START_LETTERS.length];
  letterCursor++;
  return letter;
}

// Turn any model output into a clean, rule-compliant handle or null if unusable.
// crypto mode: must start with "crypto" and end with "bot" or "robot".
// Also enforces MAX_WORD_LEN/MIN_WORD_LEN on the word portion (see comment above).
function sanitize(raw: unknown, mode: GenMode = "default"): string | null {
  if (typeof raw !== "string") return null;
  let u = raw.toLowerCase().replace(/[^a-z]/g, ""); // letters only, drops @, digits, _
  if (!u) return null;
  if (mode === "crypto" && !u.startsWith("crypto")) u = "crypto" + u;
  if (!u.endsWith("bot")) u = u + "bot"; // "robot" also ends with "bot"

  // Isolate the word id (strip "crypto" prefix and "bot" suffix) and cap it.
  let core = u;
  if (mode === "crypto") core = core.slice("crypto".length);
  core = core.slice(0, -"bot".length);
  if (core.length < MIN_WORD_LEN || core.length > MAX_WORD_LEN) return null;

  if (u.length < 6 || u.length > 24) return null;
  return u;
}

export function botDisplayName(username: string): string {
  return capitalizeFirst(username);
}

// How many times we re-ask Cerebras within one generateBotUsernames() call when a
// batch comes back too small (duplicates/junk) or a transient API error hits.
const MAX_ROUNDS = 4;

// Build the user prompt for one Cerebras request. `letter` is the forced first-word
// initial for this call (rotating sweep) — it steers the batch off the model's
// default favorites without any example words or rejected-name lists, keeping the
// prompt short.
function buildUserPrompt(
  want: number,
  mode: GenMode,
  letter: string,
  theme?: string
): string {
  const themeLine =
    mode === "custom" && theme
      ? `The names should subtly evoke this theme: "${theme}". Keep them brandable, not literal.`
      : "";

  const isCrypto = mode === "crypto";
  const L = letter.toUpperCase();

  const shapeRule = isCrypto
    ? `- MUST start with "crypto", then one or two short real English words (the FIRST word starting with "${L}"), then end with "bot"`
    : `- use one or two short real English words (the FIRST word starting with "${L}"), then end with "bot"`;

  const rules = [
    shapeRule,
    `- the word part (excluding "crypto"/"bot") must be ${MIN_WORD_LEN}-${MAX_WORD_LEN} letters total; if it won't fit, pick a shorter real word — never truncate or glue nonsense (no "lant", "pilobot")`,
    "- only real, common, instantly-recognizable English words; nothing invented/obscure/foreign/scientific",
    "- skip clichéd (already-taken) roots: nature, colors, metals, and hype words (king, boss, alpha, pro, cyber)",
    "- lowercase a-z only; no numbers, underscores, spaces or symbols",
  ];

  return [
    `Generate ${want} unique Telegram bot usernames from real, common English words.`,
    "Rules:",
    ...rules,
    themeLine,
    'JSON only: {"usernames": ["...", "..."]}',
  ]
    .filter(Boolean)
    .join("\n");
}

// One Cerebras request. Returns clean, rule-compliant handles not in `avoid`.
// Throws on any network/API/parse error so the caller can retry — no fallback.
async function callCerebrasOnce(
  key: string,
  want: number,
  avoid: string[],
  mode: GenMode,
  theme?: string
): Promise<string[]> {
  const letter = nextLetter();
  const res = await fetch(CEREBRAS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: CEREBRAS_MODEL,
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You build Telegram bot usernames using only real, common, distinctive English dictionary words — never invented/obscure words, never a word truncated or glued to hit a length limit, never a generic cliché root (nature words, elements, colors, metals, status/hype words like king/boss/alpha/elite). Word id (excluding any "crypto" prefix and "bot" suffix) is always ${MIN_WORD_LEN}-${MAX_WORD_LEN} letters. Output strict JSON only.`,
        },
        {
          role: "user",
          content: buildUserPrompt(want, mode, letter, theme),
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Cerebras HTTP ${res.status}`);
  }

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content);
  const list: unknown[] = Array.isArray(parsed?.usernames)
    ? parsed.usernames
    : Array.isArray(parsed)
    ? parsed
    : [];

  const skip = new Set(avoid);
  const cleaned: string[] = [];
  for (const item of list) {
    const handle = sanitize(item, mode);
    if (handle && !skip.has(handle)) {
      skip.add(handle);
      cleaned.push(handle);
    }
  }
  return cleaned;
}

export async function generateBotUsernames(opts: GenerateOpts): Promise<string[]> {
  const { count, theme, avoid = [], mode = "default" } = opts;
  const key = process.env.CEREBRAS_API_KEY;

  // AI-only: with no key there is nothing to generate. Caller surfaces the error.
  if (!key) return [];

  // `seen` starts with the caller's avoid list (handles already rejected by
  // BotFather this run) and grows every round, so each retry asks Cerebras for
  // words it hasn't given us yet.
  const seen = new Set(avoid);
  const out: string[] = [];

  for (let round = 0; round < MAX_ROUNDS && out.length < count; round++) {
    const want = count - out.length + BUFFER;
    try {
      const batch = await callCerebrasOnce(key, want, [...seen], mode, theme);
      for (const handle of batch) {
        if (!seen.has(handle)) {
          seen.add(handle);
          out.push(handle);
        }
      }
    } catch {
      // Transient network/API error — just try another round.
    }
  }

  return out;
}