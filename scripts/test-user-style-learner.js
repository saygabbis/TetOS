import assert from "node:assert/strict";
import {
  updateLearnedStyle,
  formatLearnedStyleForPrompt,
  detectLaughterMode,
  harvestExpressions
} from "../src/core/memory/userStyleLearner.js";

const after = updateLearnedStyle({}, "oxi mds kkkkkkk que isso vei");
assert.equal(detectLaughterMode("kkkkkk"), "kk");
assert.ok(harvestExpressions("aff né mano").length >= 2);
assert.ok(after.learned.expressions.oxi >= 1);
assert.equal(after.learned.preferredLaughter, "kk");

const lines = formatLearnedStyleForPrompt(after.learned, { prefersLaughter: true }, { userKkMaxRun: 7 });
assert.ok(lines.some((l) => /kkk/i.test(l) && /emoji/i.test(l)));

const merged = updateLearnedStyle(after, "tipo sla néh blz");
assert.ok(merged.learned.habits.usesNe >= 1);

console.log("test-user-style-learner: ok");
