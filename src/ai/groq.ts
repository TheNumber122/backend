// Groq-backed generator for Telegram bot usernames. Produces pronounceable,
// brandable made-up handles ending in "bot" (e.g. cariovobot, nasionobot),
// with NO numbers and NO underscores. Falls back to a local syllable generator
// when GROQ_API_KEY is missing or the API errors, so bot creation never hard-fails.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

interface GenerateOpts {
  count: number;
  theme?: string; // custom-pattern theme, e.g. "must be about crypto"
  avoid?: string[]; // handles already tried this run (skip duplicates)
}

// How many extra candidates to request beyond `count`, so a few "username taken"
// collisions are covered by a single AI call instead of many.
const BUFFER = 5;

function capitalizeFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Turn any model output into a clean, rule-compliant handle or null if unusable.
function sanitize(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u = raw.toLowerCase().replace(/[^a-z]/g, ""); // letters only, drops @, digits, _
  if (!u) return null;
  if (!u.endsWith("bot")) u = u + "bot";
  if (u.length < 6 || u.length > 20) return null;
  return u;
}

export function botDisplayName(username: string): string {
  return capitalizeFirst(username);
}

// Local fallback: consonant-vowel syllables + "bot". Deterministic-ish variety
// without external calls. Not as creative as the LLM but always available.
export function localBotUsernames(count: number, avoid: string[] = []): string[] {
  const cons = "bcdfgklmnprstvz".split("");
  const vowels = "aeiou".split("");
  const seen = new Set(avoid);
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard < count * 50) {
    guard++;
    const syllables = 2 + (guard % 2); // 2–3 syllables
    let word = "";
    for (let i = 0; i < syllables; i++) {
      word += cons[(guard * 7 + i * 13) % cons.length];
      word += vowels[(guard * 3 + i * 5) % vowels.length];
      if (i < syllables - 1 && (guard + i) % 3 === 0) {
        word += cons[(guard * 11 + i) % cons.length];
      }
    }
    const handle = sanitize(word);
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      out.push(handle);
    }
  }
  return out;
}

export async function generateBotUsernames(opts: GenerateOpts): Promise<string[]> {
  const { count, theme, avoid = [] } = opts;
  const want = count + BUFFER;
  const key = process.env.GROQ_API_KEY;

  if (!key) {
    return localBotUsernames(want, avoid);
  }

  const themeLine = theme
    ? `The names should subtly evoke this theme: "${theme}". Keep them brandable, not literal.`
    : "";
  const avoidLine = avoid.length
    ? `Do NOT output any of these already-used names: ${avoid.join(", ")}.`
    : "";

  const userPrompt = [
    `Generate ${want} unique Telegram bot usernames.`,
    "Strict rules:",
    "- lowercase English letters a-z ONLY",
    "- MUST end with the letters \"bot\"",
    "- NO numbers, NO underscores, NO spaces, NO symbols",
    "- 6 to 20 characters long",
    "- pronounceable, brandable, invented words (not real dictionary words)",
    "- avoid common/obvious names likely already registered on Telegram",
    "Good examples: cariovobot, nasionobot, unibopbot, rezotinrobot.",
    themeLine,
    avoidLine,
    'Respond ONLY as JSON: {"usernames": ["...", "..."]}',
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 1.05,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You invent brandable, pronounceable Telegram bot usernames. You output strict JSON only.",
          },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`Groq HTTP ${res.status}`);
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    const list: unknown[] = Array.isArray(parsed?.usernames)
      ? parsed.usernames
      : Array.isArray(parsed)
      ? parsed
      : [];

    const seen = new Set(avoid);
    const cleaned: string[] = [];
    for (const item of list) {
      const handle = sanitize(item);
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        cleaned.push(handle);
      }
    }

    // If the model under-delivered, top up locally so callers always get enough.
    if (cleaned.length < count) {
      cleaned.push(...localBotUsernames(want - cleaned.length, [...seen]));
    }
    return cleaned;
  } catch {
    // Any failure → local fallback, so the feature stays functional.
    return localBotUsernames(want, avoid);
  }
}
