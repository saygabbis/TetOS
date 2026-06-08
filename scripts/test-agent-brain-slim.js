import { createRuntime } from "../src/app/createRuntime.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const turn = await runtime.brainOrchestrator.tickTurn({
  message: "oi teto",
  userId: "test",
  sessionId: "test",
  channelId: "direct:test",
  isDirectMention: true
});
const prompt = runtime.agent.buildPrompt("oi teto", { longTerm: [], mediumTerm: [], profile: {} }, {
  brainBlocks: turn.blocks,
  brainSnapshot: turn.snapshot,
  brainOrchestratorEnabled: true,
  timingPlan: turn.timingPlan
});
assert(prompt.includes("[PERSONA — SLIM]"), "slim persona ativo");
assert(prompt.includes("[CONSCIOUS]"), "conscious block");
assert(!prompt.includes("ReferenceError"), "prompt gerado sem erro");
ok("test-agent-brain-slim");
