import { ChatService } from "../src/modules/chat/chatService.js";
import { assert, ok } from "./test-helpers.js";

const history = [
  { role: "assistant", content: "beleza então?" },
  { role: "user", content: "falou" }
];
const decision = ChatService.decideClosure("falou", history);
assert(["silent", "react", "respond", "none"].includes(decision), "valid closure decision");
assert(decision !== "none", "closure detected");
ok("test-chat-closure");
