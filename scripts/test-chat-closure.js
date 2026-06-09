import { ChatService } from "../src/modules/chat/chatService.js";
import { ResponseProcessor } from "../src/modules/chat/responseProcessor.js";
import { assert, ok } from "./test-helpers.js";

const history = [
  { role: "assistant", content: "beleza então?" },
  { role: "user", content: "falou" }
];
const decision = ChatService.decideClosure("falou", history);
assert(["silent", "react", "respond", "none", "brief_farewell"].includes(decision), "valid closure decision");
assert(decision !== "none", "closure detected");

assert(ChatService.isConversationLull("kkkkk de boa"), "kkkk de boa = lull");
assert(ChatService.isConversationLull("👍"), "emoji ack = lull");
assert(ChatService.isPositiveWellbeingReply("kkkk de boa"), "wellbeing com k na frente");

let lullDecisions = { silent: 0, react: 0, respond: 0, brief_farewell: 0 };
for (let i = 0; i < 40; i += 1) {
  const d = ChatService.decideClosure("👍", [
    { role: "assistant", content: "bora joga aí kkk" }
  ]);
  lullDecisions[d] = (lullDecisions[d] ?? 0) + 1;
}
assert(
  (lullDecisions.silent ?? 0) + (lullDecisions.react ?? 0) + (lullDecisions.brief_farewell ?? 0) >= 28,
  "👍 tende a silent/react/brief_farewell"
);

const proc = new ResponseProcessor();
const collapsed = proc.processAndGuard(
  "Vai joga aí kkk\n---\nSe precisar de energia, já aviso que a Teto tem café na reserva",
  {
    userMessage: "kkkk de boa",
    tone: "playful",
    styleHint: { userSkipTypoCorrection: true }
  }
);
assert(collapsed.length === 1, "remove segunda bolha filler");

ok("test-chat-closure");
