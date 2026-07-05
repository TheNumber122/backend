// Groq-backed generator for broadcast/drip message pools. Called ONCE per job
// (not per send) so a drip that fans out to thousands of chats costs a single
// API call. Given a theme and a count, it returns that many distinct, ready-to-
// send message texts. Mirrors the request pattern in ./groq.ts.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// Messages are generated in batches: one Groq call reliably returns ~25 good
// messages, so for large pools (up to 200) we loop, accumulating until we reach
// the target. Keeps each response high-quality instead of asking for 200 at once.
const BATCH = 25;
// Stop early if this many consecutive rounds add nothing new (theme exhausted).
const MAX_DRY_ROUNDS = 4;
// Only show the model the most recent messages as "don't repeat these" so the
// prompt stays bounded even when the pool is large (we still dedupe them all
// locally against the full set).
const AVOID_WINDOW = 40;

function clean(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  // Telegram messages cap at 4096 chars; keep well under and drop the outliers.
  if (t.length > 2000) return t.slice(0, 2000);
  return t;
}

async function callGroqOnce(
  key: string,
  want: number,
  theme: string,
  avoid: string[]
): Promise<string[]> {
  const avoidLine = avoid.length
    ? `Do NOT repeat or lightly reword any of these already-generated messages: ${avoid
        .map((m) => m.slice(0, 80))
        .join(" | ")}.`
    : "";

  const userPrompt = [
    `Write ${want} distinct short messages to broadcast to Telegram chats.`,
    `Theme / topic: "${theme}".`,
    "Rules:",
    "- each message stands alone and reads naturally on its own",
    "- vary tone, length, and opening so they don't look templated",
    "- no numbering, no surrounding quotes, no markdown headers",
    "- keep each under ~400 characters",
    "- emojis are fine but sparing",
    avoidLine,
    'Respond ONLY as JSON: {"messages": ["...", "..."]}',
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 1.0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You write engaging, natural broadcast messages for Telegram. You output strict JSON only.",
        },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);

  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(content);
  const list: unknown[] = Array.isArray(parsed?.messages)
    ? parsed.messages
    : Array.isArray(parsed)
    ? parsed
    : [];

  const skip = new Set(avoid);
  const out: string[] = [];
  for (const item of list) {
    const m = clean(item);
    if (m && !skip.has(m)) {
      skip.add(m);
      out.push(m);
    }
  }
  return out;
}

// Generate `count` distinct messages for `theme`. Retries a few times, then
// pads by cycling what it got. Throws only if Groq is unusable (no key / total
// failure) so the caller can surface a clear error before creating a job.
export async function generateBroadcastMessages(
  theme: string,
  count: number
): Promise<string[]> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not configured.");
  if (count < 1) return [];

  const seenSet = new Set<string>();
  const out: string[] = [];
  let dry = 0;

  // Enough rounds to cover the target in BATCH-sized chunks, with headroom for
  // duplicate/short responses — but bounded so it can never spin forever.
  const maxRounds = Math.ceil(count / BATCH) * 3 + 4;

  for (
    let round = 0;
    round < maxRounds && out.length < count && dry < MAX_DRY_ROUNDS;
    round++
  ) {
    const want = Math.min(BATCH, count - out.length);
    const avoid = out.slice(-AVOID_WINDOW); // only the recent tail, prompt stays small
    let added = 0;
    try {
      const batch = await callGroqOnce(key, want, theme, avoid);
      for (const m of batch) {
        if (!seenSet.has(m)) {
          seenSet.add(m);
          out.push(m);
          added++;
        }
      }
    } catch {
      // transient — try another round
    }
    dry = added === 0 ? dry + 1 : 0;
  }

  if (out.length === 0) {
    throw new Error("Failed to generate any messages from Groq.");
  }

  // Under-delivered → pad by cycling so every round of the drip has a message.
  const base = out.length;
  for (let i = 0; out.length < count; i++) {
    out.push(out[i % base]);
  }

  return out.slice(0, count);
}
