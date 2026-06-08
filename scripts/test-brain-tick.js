import { createRuntime } from "../src/app/createRuntime.js";

const runtime = createRuntime();
const brain = runtime.brainOrchestrator;
if (!brain) throw new Error("brain missing");

const turn = await brain.tickTurn({ message: "oi", userId: "test", sessionId: "test-session", channelId: "direct:test" });
console.assert(turn.snapshot?.emotion, "emotion snapshot");
console.assert(turn.blocks?.conscious, "conscious block");
brain.tickBackground();
console.log("test-brain-tick OK");
