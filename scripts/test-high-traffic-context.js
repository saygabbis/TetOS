import { createRuntime } from "../src/app/createRuntime.js";
import { runMessagePipeline, groupChannelSessionId } from "../src/core/pipeline/messagePipeline.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const savedReply = runtime.defaults.replyEnabled;
runtime.defaults.replyEnabled = true;

let capturedHistory = null;
runtime.agent.respond = async (userMessage, meta, history) => {
  capturedHistory = history;
  return "ok";
};

const groupId = "120363@test@g.us";
const groupKey = groupChannelSessionId(groupId);

for (let i = 0; i < 10; i += 1) {
  runtime.shortTerm.add({ role: "user", content: `[Ana] msg ${i}` }, groupKey);
  runtime.shortTerm.add({ role: "assistant", content: `resp ${i}` }, groupKey);
}

try {
  await runMessagePipeline(runtime, {
    message: "e aí teto, lembra do que falamos?",
    userId: "5516999999999",
    sessionId: `wa-group:120363:5516999999999`,
    channelId: groupId,
    isGroup: true,
    isDirectMention: true,
    pushName: "Gabbis"
  });

  assert(Array.isArray(capturedHistory), "history passed to agent");
  assert(capturedHistory.length >= 8, `history should keep context (got ${capturedHistory.length})`);
  assert(
    capturedHistory.length <= runtime.defaults.maxHistory,
    "history respects maxHistory cap"
  );

  const burst = await runMessagePipeline(runtime, {
    message: "linha 1\nlinha 2\nlinha 3",
    userId: "5516111111111",
    sessionId: "direct:5516111111111",
    channelId: "direct:5516111111111",
    isGroup: false
  });
  assert(burst.replies !== undefined, "burst pipeline completes");
} finally {
  runtime.defaults.replyEnabled = savedReply;
  runtime.brainOrchestrator?.destroy?.();
}

ok("test-high-traffic-context");
