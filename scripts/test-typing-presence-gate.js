import { shouldStartTypingIndicator } from "../src/core/pipeline/responseModes.js";
import { assert, ok } from "./test-helpers.js";

assert(!shouldStartTypingIndicator({ finalCloseDecision: "silent" }), "silent não digita");
assert(!shouldStartTypingIndicator({ finalCloseDecision: "react" }), "react não digita");
assert(shouldStartTypingIndicator({ finalCloseDecision: "open" }), "open digita");
assert(shouldStartTypingIndicator({ finalCloseDecision: "respond" }), "respond digita");
assert(!shouldStartTypingIndicator({ finalCloseDecision: "open", replyEnabled: false }), "reply off");
assert(!shouldStartTypingIndicator({ finalCloseDecision: "open", mainObserveOnly: true }), "observe only");

ok("test-typing-presence-gate");
