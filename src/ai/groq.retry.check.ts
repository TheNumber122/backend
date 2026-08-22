// Self-check for parseRetryAfterMs. Run: npx ts-node src/ai/groq.retry.check.ts
// No framework — throws on first failure, prints OK otherwise.
import assert from "assert";

// Re-declared here (the fn is module-private in groq.ts); keep in sync if edited.
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

assert.equal(parseRetryAfterMs("30", ""), 30_000, "header seconds win");
assert.equal(parseRetryAfterMs(null, "Please try again in 7.5s"), 7500, "seconds from body");
assert.equal(parseRetryAfterMs(null, "try again in 2m59s"), 179_000, "minutes+seconds");
assert.equal(parseRetryAfterMs(null, "try again in 1h2m"), 3_720_000, "hours+minutes");
assert.equal(parseRetryAfterMs(null, "no hint here"), 300_000, "fallback 5m");
assert.equal(parseRetryAfterMs("0", "try again in 10s"), 10_000, "zero header falls through to body");

console.log("OK: parseRetryAfterMs");
