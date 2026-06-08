import { AbsorbedKnowledgeBridge } from "../src/core/learning/absorbedKnowledgeBridge.js";
import { assert, ok } from "./test-helpers.js";

const bridge = new AbsorbedKnowledgeBridge("./data/absorbedPatterns.json");
bridge.ingestEvent({ type: "message", text: "oi", userId: "test", ts: new Date().toISOString() });
const patterns = bridge.getPatterns();
assert(patterns, "patterns object");
ok("test-absorbed-bridge");
