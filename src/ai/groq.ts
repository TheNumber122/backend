// Groq-backed generator for Telegram bot usernames. Handles are built from real,
// common English words ending in "bot" — one word on the first attempt (a shot
// at a clean single-word handle), two words on later attempts. crypto mode
// prefixes "crypto". NO numbers, NO underscores. AI-only: there is NO local
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

  // Broad, cross-category pools. Deliberately avoid the "tree/weather/generic
  // animal + bot" cliché (oak, willow, cedar, ember, storm, fox, raven...) —
  // that vocabulary is the most fished-out on Telegram and collides constantly.
  // These pull from: journeys, professions, food/spice, architecture, music,
  // space, textures/materials, abstract nouns, sport, tools.
  const singleWordDefaultPool = [
    "Marathonbot", "Compassbot", "Beaconbot", "Harvestbot", "Blizzardbot",
    "Vintagebot", "Turbobot", "Rocketbot", "Diamondbot", "Velvetbot",
    "Cinemabot", "Fusionbot", "Orbitbot", "Comedybot", "Festivalbot",
    "Marblebot", "Voyagebot", "Riddlebot", "Chroniclebot", "Fortressbot",
    "Lagoonbot", "Glacierbot", "Cactusbot", "Nebulabot", "Canyonbot",
    "Prairiebot", "Oasisbot", "Miragebot", "Tailorbot", "Bakerbot",
  ];
  const twoWordDefaultPool = [
    "GoldenCompassbot", "SilentRocketbot", "MarathonWizardbot", "VelvetComedybot",
    "CosmicHarvestbot", "PrismVoyagebot", "IronTailorbot", "AmberFortressbot",
    "CopperCanyonbot", "SilverOasisbot", "BraveNomadbot", "QuietGlacierbot",
    "RoyalCactusbot", "HiddenLagoonbot", "SwiftPilotbot",
  ];
  const singleWordCryptoPool = [
    "CryptoMarathonbot", "CryptoCompassbot", "CryptoBeaconbot", "CryptoHarvestbot",
    "CryptoVoyagebot", "CryptoOrbitbot", "CryptoFusionbot", "CryptoNebulabot",
    "CryptoRiddlebot", "CryptoTailorbot",
  ];
  const twoWordCryptoPool = [
    "CryptoGoldenCompassbot", "CryptoSilentRocketbot", "CryptoMarathonWizardbot",
    "CryptoIronTailorbot", "CryptoAmberFortressbot", "CryptoCopperCanyonbot",
  ];

  const isCrypto = mode === "crypto";
  const pool = isCrypto
    ? singleWord
      ? singleWordCryptoPool
      : twoWordCryptoPool
    : singleWord
    ? singleWordDefaultPool
    : twoWordDefaultPool;

  // Exact shape for this (mode × single-word) combination.
  const shapeRule = isCrypto
    ? singleWord
      ? '- MUST start with "crypto", then EXACTLY ONE real common English word, then end with "bot"'
      : '- MUST start with "crypto", then EXACTLY TWO real common English words, then end with "bot"'
    : singleWord
    ? '- use EXACTLY ONE real, common English word, then end with "bot"'
    : '- combine EXACTLY TWO real, common English words, then end with "bot"';

  const lengthRule = isCrypto
    ? singleWord
      ? "- 9 to 22 characters long"
      : "- 12 to 24 characters long"
    : singleWord
    ? "- 6 to 18 characters long"
    : "- 8 to 22 characters long";

  const rules = [
    shapeRule,
    "- EVERY word must be a real, common English word found in a normal dictionary",
    "- pull from a WIDE mix of categories so results don't cluster: journeys/exploration (voyage, compass, pioneer, nomad), professions (tailor, baker, pilot, sculptor), architecture (fortress, palace, lantern, archway), food & spice (cinnamon, saffron, honey, ginger), music (rhythm, anthem, chorus, echo), space (orbit, comet, nebula, satellite), textures/materials (velvet, marble, glass, brass), sport & games (marathon, riddle, puzzle, rally), abstract/story words (chronicle, legend, saga, fable) — mix categories across the batch instead of leaning on one",
    "- ABSOLUTELY NO invented, made-up, obscure, archaic, foreign, scientific, or abbreviated words (e.g. no 'garr', 'cors', 'lumen', 'vesta', 'sylvan')",
    "- AVOID overused 'nature aesthetic' bot-name roots — these are almost always already taken, so do NOT use: oak, willow, cedar, maple, ember, meadow, storm, frost, forest, river, ocean, mountain, sky, cloud, moon, sun, star, wolf, fox, raven, owl, bear, eagle, hawk, tiger, lion, panda, otter, dragon, phoenix, ninja, pixel, cyber, tech, smart, quick, super, mega, ultra, pro",
    "- lowercase a-z ONLY in the final output; NO numbers, underscores, spaces or symbols",
    lengthRule,
    "- vary the words widely across the whole batch; do NOT reuse the example words below, and do NOT let every entry come from the same category",
    `Shape/realness examples only (do NOT copy these, do NOT stick to their category): ${pickSome(pool, 4).join(", ")}.`,
  ];

  return [
    `Generate ${want} unique Telegram bot usernames.`,
    "Every username must be built ONLY from real, common English dictionary words that an average person would recognize.",
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
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You build Telegram bot usernames using ONLY real, common English dictionary words — never invented, obscure, or made-up words. You deliberately avoid clichéd 'nature aesthetic' naming (tree/weather/generic-animal words like oak, willow, cedar, ember, meadow, storm, frost, raven, fox) since those are almost always already taken — you pull from a wide spread of everyday vocabulary categories instead. You output strict JSON only.",
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
