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

console.log("OK: extractNames");
