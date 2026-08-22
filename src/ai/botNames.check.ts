// Self-check for extractNames (the PostgREST setof-shape parser).
// Run: npx ts-node src/ai/botNames.check.ts  — throws on failure, prints OK otherwise.
import assert from "assert";
import { extractNames } from "./botNames";

// scalar array shape
assert.deepEqual(extractNames(["cavbot", "cembot"]), ["cavbot", "cembot"]);
// function-name-keyed object shape
assert.deepEqual(extractNames([{ claim_bot_names: "cavbot" }]), ["cavbot"]);
// explicit username key
assert.deepEqual(extractNames([{ username: "cembot" }]), ["cembot"]);
// junk / empties dropped
assert.deepEqual(extractNames([{ x: 1 }, "", null, "okbot"]), ["okbot"]);
// non-array
assert.deepEqual(extractNames(null), []);

// Refill trigger: Groq is called only when the pool cannot fill the request.
const wantsRefill = (free: number, count: number) => free < count;
assert.equal(wantsRefill(0, 6), true, "drained pool must refill");
assert.equal(wantsRefill(3, 6), true, "partial pool must refill (short draw otherwise)");
assert.equal(wantsRefill(6, 6), false, "exact fit must not call Groq");
assert.equal(wantsRefill(300, 6), false, "full pool must not call Groq");

console.log("OK: extractNames, refill trigger");
