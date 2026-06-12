import assert from "node:assert/strict";
import {
  applyUserBoundary,
  clearUserBoundaryFacts,
  detectUserBoundary,
  isBoundaryReopening,
  isUserBoundaryActive
} from "../src/core/channels/userBoundaryDetect.js";
import { LongTermMemory } from "../src/core/memory/longTerm.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

assert.equal(detectUserBoundary("Teto to doente, n fala comigo por agora, to descansando").level, "hard");
assert.equal(detectUserBoundary("To doente depois volto").level, "hard");
assert.equal(detectUserBoundary("vou dormir").level, "soft");
assert.equal(isBoundaryReopening("oi"), true);
assert.equal(isBoundaryReopening("Teto to doente"), false);

const facts = applyUserBoundary({}, "nao fala comigo agora");
assert.ok(facts?.userBoundaryUntil);
assert.equal(isUserBoundaryActive({ facts }), true);

assert.equal(isUserBoundaryActive({ facts: clearUserBoundaryFacts(facts) }), false);

const tmp = mkdtempSync(join(tmpdir(), "tetos-boundary-"));
const mem = new LongTermMemory(join(tmp, "memory.json"));
const setFacts = applyUserBoundary({}, "to doente depois volto");
mem.updateProfile("u1", { facts: setFacts });
assert.equal(isUserBoundaryActive(mem.getProfile("u1")), true);
mem.updateProfile("u1", { facts: clearUserBoundaryFacts(mem.getProfile("u1").facts) });
assert.equal(isUserBoundaryActive(mem.getProfile("u1")), false);
rmSync(tmp, { recursive: true, force: true });

console.log("test-user-boundary: ok");
