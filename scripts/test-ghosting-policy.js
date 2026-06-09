import assert from "node:assert/strict";
import {
  analyzeGhosting,
  detectTopicClosed,
  shouldAllowInitiation
} from "../src/core/autonomy/ghostingPolicy.js";

assert.equal(detectTopicClosed("To com sono, da uma pausa aí teto"), true);
assert.equal(detectTopicClosed("Indo almocar"), true);

const ghost = analyzeGhosting({
  history: [
    { role: "user", content: "vou dormir" },
    { role: "assistant", content: "boa noite" },
    { role: "assistant", content: "e aí?" }
  ],
  gapSinceUserMs: 30 * 60_000,
  lastUserText: "vou dormir"
});
assert.equal(ghost.trailingBot, 2);
assert.equal(ghost.topicClosed, true);

const blocked = shouldAllowInitiation(ghost, { mode: "natural_lull" });
assert.equal(blocked.allow, false);

const open = analyzeGhosting({
  history: [{ role: "user", content: "oi" }],
  gapSinceUserMs: 50 * 60_000,
  lastUserText: "oi"
});
assert.equal(shouldAllowInitiation(open).allow, true);

console.log("test-ghosting-policy: ok");
