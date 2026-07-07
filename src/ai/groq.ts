// Groq-backed generator for Telegram bot usernames. Produces brandable handles
// made of TWO real English words ending in "bot" (e.g. oceandriverbot,
// cryptowormbot), with NO numbers and NO underscores. AI-only: there is NO local
// fallback. If a batch is too small or fails, it re-asks Groq, passing every
// handle already produced/rejected in the prompt so it returns fresh words.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

type GenMode = "default" | "crypto" | "custom";

interface GenerateOpts {
  count: number;
  theme?: string; // custom-pattern theme, e.g. "must be about crypto"
  avoid?: string[]; // handles already tried this run (skip duplicates)
  mode?: GenMode; // 'crypto' forces start-with-"crypto", end-with bot/robot
  // First-attempt only: ask for ONE uncommon word + "bot" (a shot at a rare,
  // still-free single-word handle). Ignored for crypto (already one word after
  // "crypto"). Later attempts drop this and use the two-word system.
  singleWord?: boolean;
}

// How many extra candidates to request beyond `count`, so a few "username taken"
// collisions are covered by a single AI call instead of many.
const BUFFER = 5;

function capitalizeFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Pick up to n random distinct items from a pool. Used to rotate the prompt
// examples per call so the model doesn't keep anchoring on the same words.
function pickSome<T>(pool: T[], n: number): T[] {
  const copy = [...pool];
  const out: T[] = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

// Turn any model output into a clean, rule-compliant handle or null if unusable.
// crypto mode: must start with "crypto" and end with "bot" or "robot".
function sanitize(raw: unknown, mode: GenMode = "default"): string | null {
  if (typeof raw !== "string") return null;
  let u = raw.toLowerCase().replace(/[^a-z]/g, ""); // letters only, drops @, digits, _
  if (!u) return null;
  if (mode === "crypto" && !u.startsWith("crypto")) u = "crypto" + u;
  if (!u.endsWith("bot")) u = u + "bot"; // "robot" also ends with "bot"
  if (u.length < 6 || u.length > 24) return null;
  return u;
}

export function botDisplayName(username: string): string {
  return capitalizeFirst(username);
}

// How many times we re-ask Groq within one generateBotUsernames() call when a
// batch comes back too small (duplicates/junk) or a transient API error hits.
const MAX_ROUNDS = 4;

// Build the user prompt for one Groq request. `avoid` lists every handle already
// produced or rejected — it goes straight into the prompt so the model returns
// fresh words instead of repeating names we can't use.
function buildUserPrompt(
  want: number,
  avoid: string[],
  mode: GenMode,
  theme?: string,
  singleWord = false
): string {
  const themeLine =
    mode === "custom" && theme
      ? `The names should subtly evoke this theme: "${theme}". Keep them brandable, not literal.`
      : "";
  const avoidLine = avoid.length
    ? `Do NOT output any of these already-used or rejected names (or close variants): ${avoid.join(", ")}.`
    : "";

  // Example pools are rotated per call (a random few each time) so the model
  // stops anchoring on the same handful of words and repeating itself.
  const cryptoExamplePool = [
    "CryptoWormbot", "CryptoFalconbot", "CryptoEmberbot", "CryptoHarborbot",
    "CryptoNomadbot", "CryptoQuartzbot", "CryptoWillowbot", "CryptoRangerbot",
    "CryptoLanternbot", "CryptoCometrobot",
  ];
  const defaultExamplePool = [
    "OceanDriverbot", "SilverFoxbot", "NightMarketbot", "IronPandabot",
    "VelvetRiverbot", "CopperLanternbot", "BraveOtterbot", "MapleThunderbot",
    "AmberFalconbot", "FrostHarborbot", "LunarNomadbot", "CrimsonPilotbot",
  ];
  const singleWordExamplePool = [
    "Zephyrbot", "Marlinbot", "Bramblebot", "Quiverbot", "Cinderbot",
    "Halcyonbot", "Petrichorbot", "Wolframbot", "Lanternbot", "Nimbusbot",
  ];
  const cryptoTwoWordExamplePool = [
    "CryptoOceanDriverbot", "CryptoSilverFoxbot", "CryptoNightMarketbot",
    "CryptoIronPandabot", "CryptoVelvetRiverbot", "CryptoBraveOtterbot",
  ];

  // Two dimensions: crypto vs default × single-word (first attempt) vs two-word
  // (fallback). Single-word is the opener for BOTH modes — for crypto that's
  // "crypto" + ONE word; the two-word fallback adds a second word.
  const rules =
    mode === "crypto"
      ? singleWord
        ? [
            '- MUST start with "crypto", then ONE real English word, then end with "bot" or "robot"',
            "- lowercase English letters a-z ONLY in the final output",
            "- NO numbers, NO underscores, NO spaces, NO symbols",
            "- 9 to 24 characters long",
            '- the word after "crypto" must be a real, meaningful English word (not invented)',
            "- prefer a rare, evocative word; vary widely and do NOT reuse the examples below",
            `Format examples (for shape only, do NOT copy these words): ${pickSome(cryptoExamplePool, 3).join(", ")}.`,
          ]
        : [
            '- MUST start with "crypto", then TWO real English words, then end with "bot" or "robot"',
            "- lowercase English letters a-z ONLY in the final output",
            "- NO numbers, NO underscores, NO spaces, NO symbols",
            "- 12 to 24 characters long",
            '- both words after "crypto" must be real, meaningful English words (not invented)',
            "- combine unexpected word pairs for variety; do NOT reuse the examples below",
            `Format examples (for shape only, do NOT copy these words): ${pickSome(cryptoTwoWordExamplePool, 3).join(", ")}.`,
          ]
      : singleWord
        ? [
            '- use exactly ONE uncommon but real English word, then end with the letters "bot"',
            "- lowercase English letters a-z ONLY in the final output",
            "- NO numbers, NO underscores, NO spaces, NO symbols",
            "- 6 to 20 characters long",
            "- pick rare, evocative, real words (not common ones, not invented gibberish)",
            "- vary widely; do NOT reuse the example words below",
            `Format examples (for shape only, do NOT copy these words): ${pickSome(singleWordExamplePool, 3).join(", ")}.`,
          ]
        : [
            '- combine TWO real, meaningful English words, then end with the letters "bot"',
            "- lowercase English letters a-z ONLY in the final output",
            "- NO numbers, NO underscores, NO spaces, NO symbols",
            "- 8 to 24 characters long",
            "- both words must be real everyday English words (e.g. adjective + noun, or noun + noun)",
            "- combine unexpected/unrelated word pairs for maximum variety; do NOT reuse the example words below",
            `Format examples (for shape only, do NOT copy these words): ${pickSome(defaultExamplePool, 3).join(", ")}.`,
          ];

  return [
    `Generate ${want} unique Telegram bot usernames.`,
    "Strict rules:",
    ...rules,
    themeLine,
    avoidLine,
    'Respond ONLY as JSON: {"usernames": ["...", "..."]}',
  ]
    .filter(Boolean)
    .join("\n");
}

// One Groq request. Returns clean, rule-compliant handles not in `avoid`.
// Throws on any network/API/parse error so the caller can retry — no fallback.
async function callGroqOnce(
  key: string,
  want: number,
  avoid: string[],
  mode: GenMode,
  theme?: string,
  singleWord = false
): Promise<string[]> {
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
            "You invent brandable Telegram bot usernames. You output strict JSON only.",
        },
        {
          role: "user",
          content: buildUserPrompt(want, avoid, mode, theme, singleWord),
        },
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
  const { count, theme, avoid = [], mode = "default", singleWord = false } = opts;
  const key = process.env.GROQ_API_KEY;

  // AI-only: with no key there is nothing to generate. Caller surfaces the error.
  if (!key) return [];

  // `seen` starts with the caller's avoid list (handles already rejected by
  // BotFather this run) and grows every round, so each retry asks Groq for words
  // it hasn't given us yet.
  const seen = new Set(avoid);
  const out: string[] = [];

  for (let round = 0; round < MAX_ROUNDS && out.length < count; round++) {
    const want = count - out.length + BUFFER;
    try {
      const batch = await callGroqOnce(key, want, [...seen], mode, theme, singleWord);
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
