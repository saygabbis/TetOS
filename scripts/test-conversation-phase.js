import { ChatService } from "../src/modules/chat/chatService.js";
import {
  analyzeConversationPhase,
  mergeBrainCloseDecision,
  resolveCloseDecision
} from "../src/core/brain/ConversationPhaseEngine.js";
import { assert, ok } from "./test-helpers.js";

const lullHistory = [
  { role: "assistant", content: "vai joga aí kkk" },
  { role: "user", content: "bora ranked" },
  { role: "assistant", content: "boa partida então" }
];

const lull = analyzeConversationPhase({
  message: "kkkk de boa",
  history: lullHistory,
  sessionId: "test-lull"
});
assert(
  ["natural_end", "lull", "winding_down"].includes(lull.phase),
  `kkkk de boa após bot = fim (got ${lull.phase})`
);
assert(["silent", "react", "respond"].includes(lull.recommendedAction), "ação de lull válida");
assert(lull.confidence >= 0.65, "confiança alta em lull");

const shift = analyzeConversationPhase({
  message: "e aquele filme que você comentou ontem, viu?",
  history: [
    { role: "user", content: "to com fome queria pedir pizza" },
    { role: "assistant", content: "pede então kkk" }
  ],
  sessionId: "test-shift"
});
assert(shift.phase === "topic_shift", "detecta mudança de assunto");
assert(shift.recommendedAction === "respond", "mudança de assunto pede resposta");

const pending = analyzeConversationPhase({
  message: "tipo assim ne",
  history: [
    { role: "assistant", content: "o que você achou do episódio?" }
  ],
  sessionId: "test-pending"
});
assert(pending.phase === "pending_answer", "pergunta pendente");

const wellbeing = analyzeConversationPhase({
  message: "de boa",
  history: [{ role: "assistant", content: "tudo bem contigo?" }],
  sessionId: "test-wellbeing"
});
assert(
  wellbeing.phase === "natural_end" || wellbeing.phase === "lull",
  "de boa a tudo bem = encerramento"
);

const resolved = resolveCloseDecision({
  message: "👍",
  history: [{ role: "assistant", content: "flw então" }],
  heuristicDecision: ChatService.decideClosure("👍", [{ role: "assistant", content: "flw então" }]),
  sessionId: "test-resolve"
});
assert(["silent", "react", "none"].includes(resolved.closeDecision), "resolve close válido");

const merged = mergeBrainCloseDecision("silent", {
  phase: "topic_shift",
  confidence: 0.8,
  closeDecision: "silent",
  topicShift: { detected: true }
});
assert(merged === "none", "brain sobrescreve silent em topic_shift");

const honor = mergeBrainCloseDecision("none", {
  phase: "natural_end",
  confidence: 0.85,
  closeDecision: "silent"
});
assert(honor === "silent", "brain reforça silent em natural_end");

let foundFarewell = false;
for (let i = 0; i < 40; i += 1) {
  const sample = analyzeConversationPhase({
    message: "falou",
    history: [{ role: "assistant", content: "beleza entao" }],
    sessionId: `farewell-${i}`
  });
  if (sample.recommendedAction === "brief_farewell") foundFarewell = true;
}
assert(foundFarewell, "despedida do usuario pode abrir brief_farewell da Teto");

const winding = analyzeConversationPhase({
  message: "kkkk de boa",
  history: [
    { role: "user", content: "bora ranked" },
    { role: "assistant", content: "boa partida entao flw" }
  ],
  sessionId: "winding-user-last"
});
assert(
  winding.recommendedAction !== "brief_farewell",
  "quando bot ja se despediu, nao forca nova despedida"
);

ok("test-conversation-phase");
