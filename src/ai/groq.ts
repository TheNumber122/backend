// Groq-backed generator for Telegram bot usernames. Default mode invents one
// short, pronounceable made-up word + "bot" (e.g. cariovobot) so handles aren't
// pre-taken; crypto mode prefixes "crypto" onto real English words + bot/robot.
// NO numbers, NO underscores.
// AI-only: there is NO local fallback. To fight repetition cheaply, each call
// forces the first word to start with the next letter in a rotating consonant
// sweep (counter-driven, not random) — so back-to-back batches can't cluster on
// the same over-farmed words, and we spend no prompt tokens listing rejected names.
//
// Groq is OpenAI-compatible. Compound uses Groq's hosted tools and returns the
// completed answer from a single request, so it can be used without a local
// tool-calling loop.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "groq/compound";

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
// callGroqOnce) — it is deliberately NOT pasted into the prompt. The rotating
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

// Counter-driven letter sweep: each Groq call forces the first word to start
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

// How many times we re-ask Groq within one generateBotUsernames() call when a
// batch comes back too small (duplicates/junk) or a transient API error hits.
const MAX_ROUNDS = 4;

// Build the user prompt for one Groq request. `letter` is the forced first-word
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
    : `- invent EXACTLY ONE short made-up word (starting with "${L}"), then end with "bot" — like cariovobot, nasionobot, unibopbot`;

  const wordKindRule = isCrypto
    ? "- only real, common, instantly-recognizable English words; nothing invented/obscure/foreign/scientific"
    : "- the word MUST be invented (not a real English word), but smooth and easily pronounceable — alternate consonants and vowels, no letter clusters, no random gibberish";

  const rules = [
    shapeRule,
    `- the word part (excluding "crypto"/"bot") must be ${MIN_WORD_LEN}-${MAX_WORD_LEN} letters total; if it won't fit, shorten it — keep it pronounceable, never glue on stray consonants`,
    wordKindRule,
    "- lowercase a-z only; no numbers, underscores, spaces or symbols",
  ];

  return [
    isCrypto
      ? `Generate ${want} unique Telegram bot usernames from real, common English words.`
      : `Generate ${want} unique Telegram bot usernames from invented, pronounceable made-up words.`,
    "Rules:",
    ...rules,
    themeLine,
    'JSON only: {"usernames": ["...", "..."]}',
  ]
    .filter(Boolean)
    .join("\n");
}

// Read the assistant text from a Groq SSE response. The API streams JSON events
// as `data:` lines; only assistant content is relevant to username generation.
async function readGroqStream(res: Response): Promise<string> {
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let content = "";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") return;

    const event = JSON.parse(payload);
    const choice = event?.choices?.[0];
    const chunk = choice?.delta?.content ?? choice?.message?.content;
    if (typeof chunk === "string") content += chunk;
  };

  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (pending) consumeLine(pending);
  return content;
}

function parseJsonContent(content: string): any {
  // JSON mode should return a bare object, but stripping a fence makes this
  // resilient to a model/provider regression without weakening validation below.
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(normalized || "{}");
}

// One Groq request. Returns clean, rule-compliant handles not in `avoid`.
// Throws on any network/API/parse error so the caller can retry — no fallback.
async function callGroqOnce(
  key: string,
  want: number,
  avoid: string[],
  mode: GenMode,
  theme?: string
): Promise<string[]> {
  const letter = nextLetter();
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // Use the current Compound tool set, including visit_website.
      "Groq-Model-Version": "latest",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 1,
      max_completion_tokens: 2048,
      top_p: 1,
      stream: true,
      stop: null,
      response_format: { type: "json_object" },
      compound_custom: {
        tools: {
          enabled_tools: ["web_search", "code_interpreter", "visit_website"],
        },
      },
      messages: [
        {
          role: "system",
          content:
            mode === "crypto"
              ? `You build Telegram bot usernames using only real, common, distinctive English dictionary words — never invented/obscure words, never a word truncated or glued to hit a length limit, never a generic cliché root (nature words, elements, colors, metals, status/hype words like king/boss/alpha/elite). Word id (excluding any "crypto" prefix and "bot" suffix) is always ${MIN_WORD_LEN}-${MAX_WORD_LEN} letters. Output strict JSON only.`
              : `You build Telegram bot usernames from invented, made-up words — NOT real English words (real words are already taken). Each word must be smooth and easily pronounceable, alternating consonants and vowels (like cariovo, nasiono, unibop), never random letter gibberish. Word id (excluding the "bot" suffix) is always ${MIN_WORD_LEN}-${MAX_WORD_LEN} letters. Output strict JSON only.`,
        },
        {
          role: "user",
          content: buildUserPrompt(want, mode, letter, theme),
        },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const suffix = detail ? `: ${detail.slice(0, 300)}` : "";
    throw new Error(`Groq HTTP ${res.status}${suffix}`);
  }

  const content = await readGroqStream(res);
  const parsed = parseJsonContent(content);
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
  const key = process.env.GROQ_API_KEY;

  // AI-only: with no key there is nothing to generate. Throw so the route logs
  // the actual configuration problem instead of reporting an opaque empty batch.
  if (!key) throw new Error("GROQ_API_KEY is not configured.");

  // `seen` starts with the caller's avoid list (handles already rejected by
  // BotFather this run) and grows every round, so each retry asks Groq for
  // words it hasn't given us yet.
  const seen = new Set(avoid);
  const out: string[] = [];
  let lastError: unknown;

  for (let round = 0; round < MAX_ROUNDS && out.length < count; round++) {
    const want = count - out.length + BUFFER;
    try {
      const batch = await callGroqOnce(key, want, [...seen], mode, theme);
      for (const handle of batch) {
        if (!seen.has(handle)) {
          seen.add(handle);
          out.push(handle);
        }
      }
    } catch (err) {
      lastError = err;
      // Transient network/API error — try another round.
    }
  }

  if (out.length === 0 && lastError) throw lastError;
  return out;
}

// Cross-job candidate pool + known-taken set, both process-lifetime and in-memory
// (no DB — free Render tier). One Groq call yields BATCH names but a single
// bot only consumes a few, so the leftovers are parked in `pool` for the next
// bot/job instead of burning another request. `tried` remembers every handle
// already sent to BotFather this process so no later job re-attempts a name we
// know is taken — the exact repetition seen in the logs.
const BATCH = 15;
const pool: Record<string, string[]> = {};
const tried = new Set<string>();

function poolKey(mode: GenMode, theme?: string): string {
  return mode === "custom" ? `custom:${theme ?? ""}` : mode;
}

// Record handles BotFather has already seen (taken/invalid/used) so they're never
// handed out again this process.
export function markTried(handles: string[]): void {
  for (const h of handles) tried.add(h);
  // ponytail: crude cap; one run rarely nears this. Persist to Supabase only if
  // cross-restart memory is ever needed.
  if (tried.size > 5000) tried.clear();
}

// Draw `count` usable handles, refilling the shared pool BATCH-at-a-time. Draws
// cost no API call until the pool runs dry.
export async function getBotUsernames(
  count: number,
  opts: { mode?: GenMode; theme?: string; avoid?: string[] }
): Promise<string[]> {
  const { mode = "default", theme, avoid = [] } = opts;
  const buf = (pool[poolKey(mode, theme)] ??= []);
  const skip = new Set([...avoid, ...tried]);
  const out: string[] = [];

  while (out.length < count) {
    while (buf.length && out.length < count) {
      const h = buf.shift()!;
      if (!skip.has(h)) {
        skip.add(h);
        out.push(h);
      }
    }
    if (out.length >= count) break;

    const fresh = await generateBotUsernames({ count: BATCH, mode, theme, avoid: [...skip] });
    const usable = fresh.filter((h) => !skip.has(h));
    if (!usable.length) break; // API down/empty or nothing new — return what we have
    buf.push(...usable);
    if (buf.length > BATCH * 2) buf.length = BATCH * 2; // ponytail: cap parked names
  }
  return out;
}