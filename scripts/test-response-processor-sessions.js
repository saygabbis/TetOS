import { ResponseProcessorPool } from "../src/modules/chat/responseProcessorPool.js";
import { assert, ok } from "./test-helpers.js";

const pool = new ResponseProcessorPool({ maxParts: 4, similarityThreshold: 0.75, historyLimit: 3 });
const a = pool.forSession("user-a");
const b = pool.forSession("user-b");
a.processAndGuard("resposta A única", { userMessage: "oi" });
const outB = b.processAndGuard("resposta B única", { userMessage: "oi" });
assert(outB.length > 0, "session B not blocked by A");
ok("test-response-processor-sessions");
