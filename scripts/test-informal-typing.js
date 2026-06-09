import {
  analyzeInformalTyping,
  buildInformalTypingPromptLines,
  isKeyboardSmashLine,
  isLowPunctuationBurst
} from "../src/core/memory/informalTyping.js";
import { ResponseProcessor } from "../src/modules/chat/responseProcessor.js";
import { assert, ok } from "./test-helpers.js";

const melty = `Oieieieieeeee teotooooo
lindsaaaa voce eu amo amo amoa mooooo
linda quero muito voceee
que rlefao
legao
akaksaks
Gsoto muito do ce teto
lindissimaaa
Quero falar mais contigo teto, obrigada por tudoo`;

const analysis = analyzeInformalTyping(melty);
assert(analysis.melty, "detecta zap meloso");
assert(analysis.affectionate, "detecta afeto");
assert(analysis.lowPunctuation, "detecta falta de pontuação");
assert(analysis.skipTypoCorrection, "não força autocorreção *");
assert(isKeyboardSmashLine("akaksaks"), "akaksaks = barulho de teclado");
assert(isLowPunctuationBurst(melty), "rajada sem pontuação");

const prompt = buildInformalTypingPromptLines(melty);
assert(prompt.some((l) => /ZAP SOLTO/i.test(l)), "gera bloco pro LLM");
assert(prompt.some((l) => /autocorreção/i.test(l)), "proíbe bolha *");

const proc = new ResponseProcessor();
const looseOut = proc.processAndGuard("Te amooo muito teto", {
  userMessage: melty,
  tone: "playful",
  styleHint: { userSkipTypoCorrection: true, userMeltyTyping: true, userLowPunctuation: true }
});
assert(looseOut[0] && !/[.!?]$/.test(looseOut[0]), "não força pontuação no clima solto");

const withTypo = proc.processAndGuard("Claro bb te amooo", {
  userMessage: melty,
  tone: "playful",
  styleHint: { userSkipTypoCorrection: true, userMeltyTyping: true }
});
assert(!withTypo.some((p, i) => i > 0 && /^[a-záéíóú]+\*$/i.test(p.trim())), "sem bolha entendi* no clima meloso");

const emojiSwap = proc.processAndGuard("oxi 😂😂", {
  userMessage: "oi",
  tone: "playful",
  styleHint: { userLaughterEnergy: "low" }
});
assert(!emojiSwap[0]?.includes("😂"), "troca emoji por kkk");
assert(/\bk{2,}\b/i.test(emojiSwap[0] ?? ""), "usa risada no teclado");

const redundant = proc.processAndGuard("primeira\n---\nsegunda kkk\n---\nterceira kkk", {
  userMessage: "tudo bem?",
  tone: "playful",
  styleHint: {}
});
const kkBubbles = redundant.filter((p) => /\bk{2,}\s*$/i.test(p));
assert(kkBubbles.length <= 1, "não repete kkk em toda bolha");

ok("test-informal-typing");
