const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "groq/compound-mini";
const REFILL_TOOLS: string[] = [];

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

const MAX_ROUNDS = 2;

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

function parseJsonContent(content: string): any {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(normalized || "{}");
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
      max_completion_tokens: 4096,
      top_p: 1,
      stream: true,
      stop: null,
      response_format: { type: "json_object" },
      compound_custom: {
        tools: {
          enabled_tools: REFILL_TOOLS,
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

  let parsed: any;
  try {
    parsed = parseJsonContent(content);
  } catch (e) {
    emit(`[groq] parse failed (${(e as Error)?.message}) — ${diag}`);
    throw e;
  }

  const list: unknown[] = Array.isArray(parsed?.usernames)
    ? parsed.usernames
    : Array.isArray(parsed)
    ? parsed
    : [];

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
  let lastError: unknown;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      const batch = await callGroqOnce(key, count, [...seen], mode, theme, emit);
      const out: string[] = [];
      for (const handle of batch) {
        if (!seen.has(handle)) {
          seen.add(handle);
          out.push(handle);
        }
      }
      return out;
    } catch (err) {
      lastError = err;
      if ((err as { retryable?: boolean })?.retryable === false) break;
    }
  }

  if (lastError) throw lastError;
  return [];
}

