// Groq-backed generator for broadcast/drip message pools. Called ONCE per job
// (not per send) so a drip that fans out to thousands of chats costs a single
// API call. Given a theme and a count, it returns that many distinct, ready-to-
// send message texts. Mirrors the request pattern in ./groq.ts.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// How many times to re-ask Groq if a batch comes back short or a transient
// error hits, before giving up and padding with what we have.
const MAX_ROUNDS = 3;

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

  const seen: string[] = [];
  const out: string[] = [];

  for (let round = 0; round < MAX_ROUNDS && out.length < count; round++) {
    const want = count - out.length;
    try {
      const batch = await callGroqOnce(key, want, theme, seen);
      for (const m of batch) {
        seen.push(m);
        out.push(m);
      }
    } catch {
      // transient — try another round
    }
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
