import assert from "node:assert/strict";
import {
  applyUserBoundary,
  detectUserBoundary,
  isBoundaryReopening,
  isUserBoundaryActive
} from "../src/core/channels/userBoundaryDetect.js";

assert.equal(detectUserBoundary("Teto to doente, n fala comigo por agora, to descansando").level, "hard");
assert.equal(detectUserBoundary("vou dormir").level, "soft");
assert.equal(isBoundaryReopening("oi"), true);
assert.equal(isBoundaryReopening("Teto to doente"), false);

const facts = applyUserBoundary({}, "nao fala comigo agora");
assert.ok(facts?.userBoundaryUntil);
assert.equal(isUserBoundaryActive({ facts }), true);

console.log("test-user-boundary: ok");
