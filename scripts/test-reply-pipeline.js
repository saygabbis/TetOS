import { createRuntime } from "../src/app/createRuntime.js";
import { runMessagePipeline } from "../src/core/pipeline/messagePipeline.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const savedReply = runtime.defaults.replyEnabled;
runtime.defaults.replyEnabled = true;
runtime.agent.brain.generate = async () => "oi, tudo bem?";

try {
  const out = await runMessagePipeline(runtime, {
    message: "oi teto",
    userId: "test_user_reply",
    sessionId: "direct:test_user_reply",
    channelId: "direct:test_user_reply",
    isGroup: false,
    closeDecision: "respond"
  });
  assert(out !== null, "pipeline returns result");
  assert(Array.isArray(out.replies), "replies array present");
  assert(out.replies.some((r) => String(r).trim().length > 0), "reply generated when enabled");
} finally {
  runtime.defaults.replyEnabled = savedReply;
  runtime.brainOrchestrator?.destroy?.();
}

ok("test-reply-pipeline");
