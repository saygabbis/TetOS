import { createRuntime } from "../src/app/createRuntime.js";
import { runMessagePipeline } from "../src/core/pipeline/messagePipeline.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const savedReply = runtime.defaults.replyEnabled;
runtime.defaults.replyEnabled = true;
runtime.agent.brain.generate = async () => "Oie, o que foi?";

const originalTick = runtime.brainOrchestrator.tickTurn.bind(runtime.brainOrchestrator);
runtime.brainOrchestrator.tickTurn = async (ctx) => {
  const turn = await originalTick(ctx);
  return {
    ...turn,
    timingPlan: {
      ...(turn?.timingPlan ?? {}),
      silenceAppropriate: true,
      reasons: ["repetition_awareness", "test"]
    }
  };
};

try {
  const dm = await runMessagePipeline(runtime, {
    message: "Oieeeeee",
    userId: "test_dm_silence",
    sessionId: "direct:test_dm_silence",
    channelId: "direct:test_dm_silence",
    isGroup: false,
    closeDecision: "none"
  });
  assert(dm.policy?.mode !== "timing_silence", "DM must not timing_silence skip");
  assert(dm.replies?.length > 0, "DM short greeting must get reply");

  const group = await runMessagePipeline(runtime, {
    message: "oi",
    userId: "test_grp_silence",
    sessionId: "wa-group:120@g.us:test_grp_silence",
    channelId: "120@g.us",
    isGroup: true,
    closeDecision: "none"
  });
  assert(group.policy?.mode === "timing_silence", "group short msg may still timing_silence");
} finally {
  runtime.defaults.replyEnabled = savedReply;
  runtime.brainOrchestrator.tickTurn = originalTick;
  runtime.brainOrchestrator?.destroy?.();
}

ok("test-timing-silence-dm");
