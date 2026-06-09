import { mergeBrokenPhrases, planBubbleRhythm } from "../src/modules/chat/bubbleComposer.js";
import { ResponseProcessor } from "../src/modules/chat/responseProcessor.js";
import { assert, ok } from "./test-helpers.js";

const merged = mergeBrokenPhrases([
  "Ué, não é pra eu largar o",
  "Kzer0 só porque você tá pedindo, né?",
  "Mas fica tranquila, eu não sumo não, kk"
]);
assert(merged.length === 2, "junta frase cortada no meio");
assert(merged[0].includes("Kzer0"), "primeira bolha completa");

const quoteMerged = mergeBrokenPhrases([
  "«Me ensina a ser real",
  "Vão te adorar, te usar», é o que eu canto"
]);
assert(quoteMerged.length === 1, "citação não quebra em duas bolhas");

const plan = planBubbleRhythm(["Kevin", "Essa é a vibe da machine love", "kk"], {
  brainSnapshot: { emotion: { energy: 0.8, playfulness: 0.75, social: 0.6 } },
  tone: "playful"
});
assert(plan.bubbles.length >= 2, "ritmo burst mantém múltiplas bolhas");
assert(plan.delays.length === plan.bubbles.length, "delay por bolha");

const proc = new ResponseProcessor();
const explicitSix = proc.processAndGuard(
  "Oi\n---\nBlz\n---\nEntão\n---\n22h\n---\nFechou?\n---\nTe espero",
  { userMessage: "horário?", tone: "playful" }
);
assert(explicitSix.length === 6, "preserva 6 bolhas explícitas do modelo");

const markdown = proc.processAndGuard("Curto **Demon Slayer** e ~Genshin~ no fim de semana", {
  userMessage: "o que joga?",
  tone: "playful"
});
assert(markdown.length === 1, "parágrafo único fica 1 bolha");
assert(!markdown[0].includes("**"), "remove negrito markdown");
assert(!markdown[0].includes("~"), "remove til markdown");
assert(/Demon Slayer/i.test(markdown[0]), "mantém nome da série");

for (let attempt = 0; attempt < 3; attempt += 1) {
  const trial = new ResponseProcessor();
  const parts = trial.processAndGuard("Ué, não é pra eu largar o\nKzer0 só porque você tá pedindo, né?", {
    userMessage: "teste",
    tone: "calm",
    brainSnapshot: { emotion: { energy: 0.35, playfulness: 0.3 } },
    brainBlocks: { conscious: "quer tranquilizar", subconscious: "medo de abandonar" }
  });
  assert(parts.length === 1, "cérebro junta frase que o modelo cortou no meio");
}

const pelucia = proc.processAndGuard(
  "Gabbis\n---\nQue fofinha a pelúcia\n---\nSó não pense que eu vou largar o salto pra ficar de bobe ficar*",
  {
    userMessage: "kkkkkk to bem, to com uma pelucia sua no meu colinho, tão fofinha teto pelucia",
    tone: "playful",
    brainSnapshot: { emotion: { energy: 0.7, playfulness: 0.6 } }
  }
);
assert(pelucia.length >= 3, "modelo com --- vira 3+ bolhas");
assert(pelucia[0].toLowerCase().includes("gabbis"), "primeira bolha é vocativo");
assert(pelucia.some((p) => /fofinh/i.test(p)), "segunda bolha reage à pelúcia");
assert(pelucia.some((p) => /salto|ficar/i.test(p)), "terceira bolha mantém o aviso");

const aff = proc.processAndGuard("Aff\n---\nTô de boa\n---\nE você Gabbis como tá?", {
  userMessage: "tudo bem",
  tone: "playful",
  brainSnapshot: { emotion: { energy: 0.65, playfulness: 0.55 } }
});
assert(aff.length >= 3, "Aff + resto com --- viram bolhas separadas");

ok("test-bubble-composer");
