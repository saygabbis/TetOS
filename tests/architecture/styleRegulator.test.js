import { describe, expect, it } from "vitest";
import {
  extractOpener,
  recentAssistantTurns,
  regulateBubbles,
  regulateMessageActions,
  tameRawReply,
  tamePunctuation
} from "../../src/modules/chat/styleRegulator.js";

const run = (texts, ctx) => regulateBubbles(texts, ctx).texts;

describe("regulador de estilo", () => {
  it("encurta pontuação exagerada", () => {
    expect(tamePunctuation("sério!!!! como assim????? ?!?!?!")).toBe("sério!! como assim?? ?!");
  });

  it("deixa só um trecho curto em CAPS por resposta", () => {
    expect(run(["MENTIRA!! KKKKKKK", "MEU DEUS GABBIS!!!", "conta"])).toEqual(["MENTIRA!! KKKKKKK", "meu deus gabbis!!", "conta"]);
  });

  it("frase inteira gritando vira minúscula; risada e sigla ficam", () => {
    expect(run(["EU TO MUITO FELIZ HOJE kkkk"])).toEqual(["eu to muito feliz hoje kkkk"]);
    expect(run(["KKKKKKKKKKK"])).toEqual(["KKKKKKKKKKK"]);
    expect(run(["vou no evento de UTAU com a Miku"])).toEqual(["vou no evento de UTAU com a Miku"]);
  });

  it("não grita duas respostas seguidas", () => {
    expect(run(["NÃO acredito"], { recentTurns: [["MENTIRA kkk"]] })).toEqual(["não acredito"]);
  });

  it("tira interjeição que abriu a resposta anterior", () => {
    expect(run(["mds que isso kkkk", "conta"], { recentTurns: [["MDS kkkk"]] })).toEqual(["que isso kkkk", "conta"]);
    expect(run(["mds", "conta"], { recentTurns: [["mds kkkk"]] })).toEqual(["conta"]);
    expect(run(["mds que isso"], { recentTurns: [["oi"], ["tudo bem"]] })).toEqual(["mds que isso"]);
  });

  it("risada no começo só vira tique depois de duas seguidas", () => {
    expect(run(["kkkk né"], { recentTurns: [["kkk sim"]] })).toEqual(["kkkk né"]);
    expect(run(["kkkk né"], { recentTurns: [["kkk sim"], ["kkkkk não"]] })).toEqual(["né"]);
    expect(extractOpener("KKKKK que isso")).toBe("<risada>");
  });

  it("limita bolhas: 3 no PV, 2 no grupo, juntando o excesso", () => {
    expect(run(["a", "b", "c", "d"])).toEqual(["a", "b", "c\nd"]);
    expect(run(["a", "b", "c"], { isGroup: true })).toEqual(["a", "b\nc"]);
    expect(run(["a", "b", "c"], { maxParts: 1 })).toEqual(["a\nb\nc"]);
  });

  it("remove bolha repetida", () => {
    expect(run(["oi", "Oi!", "tudo bem?"])).toEqual(["oi", "tudo bem?"]);
    expect(run(["tudo bem com você?", "e aí"], { recentTurns: [["tudo bem com você?"]] })).toEqual(["e aí"]);
  });

  it("ações: só as mensagens mudam, a ordem e o quote ficam", () => {
    const out = regulateMessageActions([
      { type: "react", emoji: "😂" },
      { type: "message", text: "a", quoteId: "Q1" },
      { type: "message", text: "b" },
      { type: "sticker", key: "x" },
      { type: "message", text: "c" },
      { type: "message", text: "d", quoteId: "Q2" }
    ]);
    expect(out).toEqual([
      { type: "react", emoji: "😂" },
      { type: "message", text: "a", quoteId: "Q1" },
      { type: "message", text: "b", quoteId: null },
      { type: "sticker", key: "x" },
      { type: "message", text: "c\nd", quoteId: "Q2" }
    ]);
  });

  it("lê as bolhas antigas do histórico cru", () => {
    const turns = recentAssistantTurns([
      { role: "assistant", content: 'mensagem("MDs o que é isso kkk", "AC985DDE6BD")\n---\nmensagem("sabor (novo)?? Gabbis")' },
      { role: "user", content: "x" },
      { role: "assistant", content: "oi, tudo bem?" }
    ]);
    expect(turns).toEqual([["oi, tudo bem?"], ["MDs o que é isso kkk", "sabor (novo)?? Gabbis"]]);
  });

  it("histórico: corrige o texto sem mexer em comando nem id", () => {
    const raw = 'reagir("😂")\nmensagem("MEU DEUS QUE ISSO!!!!", "AC985DDE6BDE2CD")\n---\nmensagem("conta TUDO")';
    expect(tameRawReply(raw)).toBe('reagir("😂")\nmensagem("meu deus que isso!!", "AC985DDE6BDE2CD")\n---\nmensagem("conta TUDO")');
  });
});

describe("regulador nunca some com a resposta", () => {
  it("mesmo se todas as bolhas baterem com o turno anterior", () => {
    const t = ["oie @Bia! prazer kkk", "amiga da Gabbis já ganha pontos"];
    expect(run(t, { isGroup: true, recentTurns: [t] }).length).toBeGreaterThan(0);
  });
});

describe("grupo: não repete pra todo mundo", () => {
  it("resposta inteira igual à anterior some no grupo, fica no PV", () => {
    const last = [["não sou rádio pra cantar agora, pede pro Spotify kkkk"]];
    expect(run(["não sou rádio pra cantar agora, pede pro Spotify kkkk"], { isGroup: true, dropIfAllRepeated: true, recentTurns: last })).toEqual([]);
    expect(run(["não sou rádio pra cantar agora, pede pro Spotify kkkk"], { recentTurns: last }).length).toBe(1);
  });
});
