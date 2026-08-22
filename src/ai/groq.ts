const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// NOT a compound/agentic model: those spend the whole completion on delta.reasoning
// attempting a tool loop and emit no delta.content, so a 200 OK parsed to 0 names.
// Verified against /v1/models — this key has no llama-* access at all.
const GROQ_MODEL = "openai/gpt-oss-20b";

// This key's limit is 8000 tokens/min and Groq reserves max_completion_tokens
// UPFRONT, so a big ceiling throttles us to one call per minute. 1200 fits ~40
// names with room for the JSON envelope and still allows ~6 calls/min.
const MAX_OUT_TOKENS = 1200;
// Asking for 300 in one call returns HTTP 400 json_validate_failed — the model
// can't hold that many unique invented words coherently. One call also repeats
// itself heavily within a single start letter (measured: 139 returned, 21 unique),
// so large requests are filled by looping letters via nextLetter().
const BATCH = 40;
const MAX_DRY_ROUNDS = 3;
// 8000 TPM / MAX_OUT_TOKENS reserved per call ≈ 6 calls/min. Pace ourselves rather
// than earn a 429 that cools down the whole generator mid-fill.
const CALL_SPACING_MS = Math.ceil(60_000 / Math.floor(8000 / MAX_OUT_TOKENS));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type GenMode = "default" | "crypto" | "custom";

interface GenerateOpts {
  count: number;
  theme?: string;
  avoid?: string[];
  mode?: GenMode;
  log?: (message: string) => void;
}

const MAX_WORD_LEN = 8;
const MIN_WORD_LEN = 3;

function capitalizeFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

const START_LETTERS = "bcdfghjklmnprstvw".split("");
let letterCursor = 0;
function nextLetter(): string {
  const letter = START_LETTERS[letterCursor % START_LETTERS.length];
  letterCursor++;
  return letter;
}

function sanitize(raw: unknown, mode: GenMode = "default"): string | null {
  if (typeof raw !== "string") return null;
  let u = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!u) return null;
  if (mode === "crypto" && !u.startsWith("crypto")) u = "crypto" + u;
  if (!u.endsWith("bot")) u = u + "bot";

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

let cooldownUntil = 0;

function parseRetryAfterMs(header: string | null, body: string): number {
  const ra = Number(header);
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  const m = body.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
    if (ms > 0) return ms;
  }
  return 5 * 60_000;
}

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
    // Without these the model collapses onto one skeleton and repeats: a single
    // 150-name call measured 139 returned but only 21 distinct.
    "- vary the vowel pattern and syllable shape across the list; never reuse the same skeleton with one letter swapped",
    "- every entry must be distinct from all the others",
    "- lowercase a-z only; no numbers, underscores, spaces or symbols",
  ];

  return [
    isCrypto
      ? `Generate ${want} unique Telegram bot usernames from real, common English words.`
      : `Generate ${want} unique Telegram bot usernames from invented, pronounceable made-up words.`,
    "Rules:",
    ...rules,
    themeLine,
    "Output ONE username per line. No numbering, no JSON, no commentary.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function readGroqStream(res: Response): Promise<{ content: string; raw: string; error: any }> {
  if (!res.body) return { content: "", raw: "", error: null };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let content = "";
  let raw = "";
  let streamError: any = null;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") return;

    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event?.error) {
      streamError = event.error;
      return;
    }
    const choice = event?.choices?.[0];
    const chunk = choice?.delta?.content ?? choice?.message?.content;
    if (typeof chunk === "string") content += chunk;
  };

  while (true) {
    const { value, done } = await reader.read();
    const text = decoder.decode(value, { stream: !done });
    raw += text;
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (pending) consumeLine(pending);
  return { content, raw, error: streamError };
}

// Newline-delimited, not JSON: with response_format json_object, hitting the token
// ceiling mid-array made Groq reject the ENTIRE call (stream error 400
// json_validate_failed) and we got nothing. Line-per-name degrades gracefully —
// a truncated final line is one dropped name, and sanitize() rejects stray prose.
function parseLines(content: string): string[] {
  return content
    .split(/[\r\n,]+/)
    .map((l) => l.trim().replace(/^[-*\d.)\s]+/, "").replace(/^@/, ""))
    .filter(Boolean);
}

async function callGroqOnce(
  key: string,
  want: number,
  avoid: string[],
  mode: GenMode,
  theme: string | undefined,
  emit: (message: string) => void
): Promise<string[]> {
  const letter = nextLetter();
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "Groq-Model-Version": "latest",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 1,
      max_completion_tokens: MAX_OUT_TOKENS,
      top_p: 1,
      // gpt-oss streams chain-of-thought into delta.reasoning, which we discard —
      // keep it minimal so the token budget goes to actual names.
      reasoning_effort: "low",
      stream: true,
      stop: null,
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
    if (res.status === 429) {
      cooldownUntil = Date.now() + parseRetryAfterMs(res.headers.get("retry-after"), detail);
    }
    const retryable = res.status >= 500;
    throw Object.assign(new Error(`Groq HTTP ${res.status}${suffix}`), { retryable });
  }

  const { content, raw, error: streamError } = await readGroqStream(res);
  const diag = `HTTP ${res.status} ct=${res.headers.get("content-type") ?? ""} reqid=${res.headers.get("x-request-id") ?? res.headers.get("x-groq-request-id") ?? ""} raw ${raw.length}c: ${JSON.stringify(raw.slice(0, 500))}`;

  if (streamError) {
    const status = Number(streamError.status_code) || 0;
    if (status === 429) {
      cooldownUntil = Date.now() + parseRetryAfterMs(res.headers.get("retry-after"), String(streamError.message ?? ""));
    }
    emit(`[groq] stream error ${status} — ${diag}`);
    const retryable = status >= 500;
    throw Object.assign(
      new Error(`Groq stream error ${status}: ${String(streamError.message ?? "").slice(0, 200)}`),
      { retryable }
    );
  }

  // Empty content is a failed call, not an empty result — surface it (and let the
  // round loop retry) instead of parsing "{}" into a silent 0 names.
  if (!content.trim()) {
    emit(`[groq] no content in stream — ${diag}`);
    throw new Error("Groq returned no content");
  }

  const list: unknown[] = parseLines(content);


  const skip = new Set(avoid);
  const cleaned: string[] = [];
  let sanitizedCount = 0;
  for (const item of list) {
    const handle = sanitize(item, mode);
    if (!handle) continue;
    sanitizedCount++;
    if (!skip.has(handle)) {
      skip.add(handle);
      cleaned.push(handle);
    }
  }

  emit(
    `[groq] result letter=${letter} parsed=${list.length} sanitized=${sanitizedCount} new=${cleaned.length}` +
      (cleaned.length === 0 ? ` | ${diag}` : ` | ${cleaned.slice(0, 8).join(", ")}`)
  );

  return cleaned;
}

export async function generateBotUsernames(opts: GenerateOpts): Promise<string[]> {
  const { count, theme, avoid = [], mode = "default", log } = opts;
  const emit = log ?? ((m: string) => console.log(m));
  const key = process.env.GROQ_API_KEY;

  if (!key) throw new Error("GROQ_API_KEY is not configured.");

  if (Date.now() < cooldownUntil) {
    emit(`[groq] cooling down ${Math.round((cooldownUntil - Date.now()) / 1000)}s — skipping generation`);
    return [];
  }

  const seen = new Set(avoid);
  const out: string[] = [];
  let dry = 0;
  let calls = 0;
  let lastError: unknown;

  // One call cannot fill a large request (400s past ~150, and repeats itself
  // within a start letter), so loop BATCH at a time — nextLetter() advances the
  // start letter each call, which is what actually produces distinct names.
  while (out.length < count && dry < MAX_DRY_ROUNDS) {
    const want = Math.min(BATCH, count - out.length);
    if (calls > 0) await sleep(CALL_SPACING_MS);
    calls++;
    let batch: string[];
    try {
      batch = await callGroqOnce(key, want, [...seen], mode, theme, emit);
    } catch (err) {
      lastError = err;
      // A 429 sets cooldownUntil; anything already collected is still worth keeping.
      if (Date.now() < cooldownUntil) break;
      dry++;
      continue;
    }

    const before = out.length;
    for (const handle of batch) {
      if (out.length >= count) break;
      if (!seen.has(handle)) {
        seen.add(handle);
        out.push(handle);
      }
    }
    dry = out.length > before ? 0 : dry + 1;
  }

  // Only a total failure is an error — a short draw still beats none.
  if (!out.length && lastError) throw lastError;
  emit(`[groq] generated ${out.length}/${count} unique (mode=${mode})`);
  return out;
}

