import {
  collapseForShortUserPrompt,
  hasCoherenceIssues,
  hasVocativeToTeto,
  isContextBlindReply,
  isIncompleteBubble,
  isMisplacedOpeningGreeting,
  isShortEnthusiasticReply,
  isVocativeToTeto,
  normalizeInformalEnding,
  repairBubbleCoherence
} from "../src/modules/chat/coherenceGuards.js";
import { assert, ok } from "./test-helpers.js";

assert(isIncompleteBubble("Não que eu estivesse"), "fragmento cortado");
assert(!isIncompleteBubble("Não que eu estivesse esperando, amiga."), "frase completa ok");
assert(isVocativeToTeto("Amiga"), "amiga é vocativo");
assert(
  isMisplacedOpeningGreeting("Oi, Gabbis!", "Amiga", { hasHistory: true }),
  "oi+nome fora de lugar"
);
assert(
  hasCoherenceIssues(["Oi, Gabbis!", "Não que eu estivesse"], "Amiga", { hasHistory: true }),
  "caso do print"
);

const repaired = repairBubbleCoherence(["Não que eu estivesse", "esperando você, amiga"]);
assert(repaired.length === 1 && !isIncompleteBubble(repaired[0]), "junta fragmento com continuação");

const collapsed = collapseForShortUserPrompt(["Oi, amiga!", "Tô aqui."], "Amiga");
assert(collapsed.length === 1, "vocativo curto vira uma bolha");

assert(
  normalizeInformalEnding("eu acabo pedindo a pizza no teu lugar,") ===
    "eu acabo pedindo a pizza no teu lugar",
  "remove vírgula pendurada"
);
assert(
  normalizeInformalEnding("aff que fome.") === "aff que fome",
  "remove ponto final informal"
);
assert(hasVocativeToTeto("To com fome amiga"), "amiga no fim conta");

assert(
  isShortEnthusiasticReply("EU EUE U EU QUERO", "combo de bolinha de queijo", []),
  "empolgação com ruído + quote"
);
assert(
  isContextBlindReply(
    ["Quer dizer que tá afim de alguma coisa? Manda logo, Gabbis!"],
    "EU EUE U EU QUERO",
    {
      quotedMessage: "combo de bolinha de queijo e cura a fome fechou?",
      recentHistory: [{ role: "assistant", content: "combo de bolinha de queijo" }]
    }
  ),
  "detecta resposta cega ao quote"
);

ok("test-coherence-guards");
