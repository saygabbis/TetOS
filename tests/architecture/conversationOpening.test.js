import { describe, expect, it } from "vitest";
import {
  isGreetingOpener,
  mergeBrainCloseDecision,
  resolveCloseDecision
} from "../../src/core/brain/ConversationPhaseEngine.js";

const botTalkedLast = [
  { role: "user", content: "kkkk boa" },
  { role: "assistant", content: "é isso msm kkkkk" },
  { role: "assistant", content: "tô aqui na luta com os stems kkk" }
];

const decide = (message, extra = {}) =>
  resolveCloseDecision({ message, history: botTalkedLast, sessionId: "wa-dm:teste", ...extra });

describe("abertura de conversa nunca é ignorada", () => {
  it("reconhece cumprimentos", () => {
    for (const msg of ["oi", "Oiiii", "oie", "eai", "e aí", "olá", "bom dia!", "boa tarde", "voltei", "opa"]) {
      expect(isGreetingOpener(msg), msg).toBe(true);
    }
    for (const msg of ["oi tudo bem? queria te contar uma coisa enorme que aconteceu hoje", "obrigada", "sim"]) {
      expect(isGreetingOpener(msg), msg).toBe(false);
    }
  });

  it("'Oiiii' depois de várias bolhas da Teto responde (bug: virava natural_end/silent)", () => {
    const { closeDecision, analysis } = decide("Oiiii");
    expect(closeDecision).toBe("none");
    expect(analysis.phase).toBe("opening");
  });

  it("mensagem curta com conteúdo não é tratada como fim de papo", () => {
    for (const msg of ["e vc?", "pq?", "cadê?", "sério"]) {
      expect(decide(msg).closeDecision, msg).not.toBe("silent");
    }
  });

  it("confirmação mínima depois de várias bolhas ainda pode encerrar", () => {
    expect(decide("aham").closeDecision).toBe("silent");
  });

  it("pausa longa transforma lull em papo novo", () => {
    const { closeDecision, analysis } = decide("kkkk", { gapSinceLastMs: 2 * 60 * 60 * 1000 });
    expect(closeDecision).toBe("none");
    expect(analysis.phase).toBe("opening");
  });

  it("despedida explícita continua sendo despedida", () => {
    expect(decide("tchau, vou dormir").analysis.phase).toBe("hard_close");
  });

  it("cérebro não reverte a abertura para silêncio", () => {
    expect(mergeBrainCloseDecision("silent", { phase: "opening", confidence: 0.9, closeDecision: "none" })).toBe("none");
  });
});
