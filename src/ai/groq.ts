// Groq-backed generator for Telegram bot usernames. Handles are built from real,
// common English words ending in "bot" — one word on the first attempt (a shot
// at a clean single-word handle), a single/compound word on later attempts.
// crypto mode prefixes "crypto". NO numbers, NO underscores. AI-only: there is
// NO local fallback. If a batch is too small or fails, it re-asks Groq, passing
// every handle already produced/rejected in the prompt so it returns fresh words.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

type GenMode = "default" | "crypto" | "custom";

interface GenerateOpts {
  count: number;
  theme?: string; // custom-pattern theme, e.g. "must be about crypto"
  avoid?: string[]; // handles already tried this run (skip duplicates)
  mode?: GenMode; // 'crypto' forces start-with-"crypto", end-with bot/robot
  // First-attempt only: ask for ONE short real word + "bot" (a shot at a rare,
  // still-free single-word handle). Ignored for crypto (already one word after
  // "crypto"). Later attempts drop this and allow natural compound words too.
  singleWord?: boolean;
}

// How many extra candidates to request beyond `count`, so a few "username taken"
// collisions are covered by a single AI call instead of many.
const BUFFER = 5;

// How many `avoid` entries actually get pasted into the prompt text. The full
// avoid list still guarantees no duplicates in the OUTPUT (see the `skip` Set
// in callGroqOnce, which always uses the complete list) — this cap only limits
// how many tokens we spend narrating rejected names to the model, which was
// the single biggest cost driver since that list grows every retry round.
const MAX_AVOID_IN_PROMPT = 20;

// Hard cap on the "word id" portion of the handle — i.e. everything except the
// literal "crypto" prefix (crypto mode) and the "bot" suffix. Enforced here in
// code, not just in the prompt, because the model doesn't always respect
// length instructions (it sometimes truncates/glues words to force a fit,
// e.g. "lanthem", "pilobot" — this cap + the sanitize check below stop that).
const MAX_WORD_LEN = 7;
const MIN_WORD_LEN = 3;

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
  const avoidForPrompt = avoid.slice(-MAX_AVOID_IN_PROMPT);
  const avoidLine = avoidForPrompt.length
    ? `Avoid these already-used names (or close variants): ${avoidForPrompt.join(", ")}.`
    : "";

  // All pools contain ONLY words that are 7 letters or fewer, so examples never
  // contradict the length rule. Wide spread of categories, avoiding the
  // "nature aesthetic" cliché that's already fished out on Telegram.
  const singleWordDefaultPool = [
    "Compassbot", "Beaconbot", "Harvestbot", "Vintagebot", "Rocketbot",
    "Comedybot", "Marblebot", "Riddlebot", "Canyonbot", "Prairiebot",
    "Oasisbot", "Miragebot", "Tailorbot", "Bakerbot", "Orbitbot",
    "Rhythmbot", "Anthembot", "Choralbot", "Legendbot", "Puzzlebot",
    "Rallybot", "Pilotbot", "Nomadbot", "Fablebot", "Velvetbot",
    "Cinemabot", "Fusionbot", "Lagoonbot", "Cactusbot", "Palacebot",
    "Lanternbot", "Saffronbot", "Gingerbot", "Cobaltbot", "Bronzebot",
    "Jasperbot", "Cottonbot", "Violinbot", "Sonnetbot", "Cipherbot",
  ];
  // Real, single-word English compounds (already recognized as ONE dictionary
  // word, not two words stuck together) plus short single words — this is what
  // "not single-word" now means. It avoids asking the model to weld two
  // separate words into a tiny budget, which is what produced junk like
  // "lanthem" / "pilobot" / "hansebot" before.
  const twoWordDefaultPool = [
    "Gatewaybot", "Roadmapbot", "Outpostbot", "Kickoffbot", "Handoffbot",
    "Checkupbot", "Toolboxbot", "Bellhopbot", "Postboxbot", "Logbookbot",
    "Hallwaybot", "Walkwaybot", "Carpoolbot", "Payloadbot", "Landingbot",
    "Rooftopbot",
  ];
  const singleWordCryptoPool = [
    "CryptoPilotbot", "CryptoBakerbot", "CryptoOrbitbot", "CryptoRallybot",
    "CryptoNomadbot", "CryptoFablebot", "CryptoAtlasbot", "CryptoCargobot",
    "CryptoGlobebot", "CryptoJasperbot",
  ];
  const twoWordCryptoPool = [
    "CryptoGatewaybot", "CryptoOutpostbot", "CryptoKickoffbot",
    "CryptoToolboxbot", "CryptoPayloadbot", "CryptoRooftopbot",
  ];

  const isCrypto = mode === "crypto";
  const pool = isCrypto
    ? singleWord
      ? singleWordCryptoPool
      : twoWordCryptoPool
    : singleWord
    ? singleWordDefaultPool
    : twoWordDefaultPool;

  const shapeRule = isCrypto
    ? singleWord
      ? '- MUST start with "crypto", then EXACTLY ONE short real English word, then end with "bot"'
      : '- MUST start with "crypto", then ONE real English word OR ONE natural English compound word (a word already recognized as a single dictionary word, like "gateway" or "toolbox" — NOT two separate words stuck together), then end with "bot"'
    : singleWord
    ? '- use EXACTLY ONE short real English word, then end with "bot"'
    : '- use ONE real English word OR ONE natural English compound word (a word already recognized as a single dictionary word, like "gateway" or "toolbox" — NOT two separate words stuck together), then end with "bot"';

  const rules = [
    shapeRule,
    `- word id (excl. "crypto"/"bot") must be ${MIN_WORD_LEN}-${MAX_WORD_LEN} letters; pick a shorter real word if it doesn't fit — never truncate or glue words together (no "lant", "pilobot", "hansebot")`,
    "- every word = real, common, instantly-recognizable English dictionary word; no invented/obscure/archaic/foreign/scientific/abbreviated words",
    "- mix categories across the batch (travel, professions, architecture, food/spice, music, materials, sport, everyday objects) — don't cluster on one",
    "- avoid overused roots (nearly always taken): nature (oak, willow, cedar, ember, sand, stone, storm, river, moon, fox, wolf, raven, owl, dragon), elements/colors/metals (water, fire, ice, gold, silver, red, blue, iron, steel), status/hype words (king, boss, alpha, elite, prime, ultra, pro, ninja, cyber, tech)",
    "- creativity check: if a word is a generic element/color/status noun, swap it for something more specific and distinctive",
    "- lowercase a-z only, no numbers/underscores/spaces/symbols",
    "- vary widely; don't reuse the examples below or cluster on one category",
    `Examples (shape/length only, don't copy or stay in their category): ${pickSome(pool, 4).join(", ")}.`,
  ];

  return [
    `Generate ${want} unique Telegram bot usernames from real, common English words.`,
    "Rules:",
    ...rules,
    themeLine,
    avoidLine,
    'JSON only: {"usernames": ["...", "..."]}',
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