import { describe, expect, it } from "vitest";
import { classifyMessage, governActions, governLaughter, readTone, stripLaughter, tonePromptLines } from "../../src/core/mind/toneReader.js";
import { regulateBubbles, stripThinkCommands } from "../../src/modules/chat/styleRegulator.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";

describe("leitura de tom", () => {
  it("crise: falar em se matar é sério, mesmo escrito de leve", () => {
    expect(classifyMessage("Se um dia eu me matar")).toBe("crise");
    expect(classifyMessage("caso eu me suicidar")).toBe("crise");
    expect(classifyMessage("não quero mais viver")).toBe("crise");
    expect(classifyMessage("quero morrer")).toBe("crise");
  });

  it("exagero de zap não é crise", () => {
    expect(classifyMessage("morri de rir kkkk")).toBe("brincadeira");
    expect(classifyMessage("quero morrer kkkkk que vergonha")).not.toBe("crise");
    expect(classifyMessage("eu me mato de trabalhar")).not.toBe("crise");
  });

  it("outros tons", () => {
    expect(classifyMessage("to muito triste hoje")).toBe("triste");
    expect(classifyMessage("minha avó faleceu")).toBe("triste");
    expect(classifyMessage("para de rir")).toBe("irritado");
    expect(classifyMessage("como funciona o enem?")).toBe("serio");
    expect(classifyMessage("te amo teto")).toBe("carinho");
    expect(classifyMessage("KKKKKKK olha isso")).toBe("brincadeira");
    expect(classifyMessage("bom dia")).toBe("normal");
  });

  it("o tom gruda: depois de crise, 'desculpa' continua no cuidado", () => {
    const now = Date.now();
    const t = readTone("desculpa", { recentUserTexts: [{ text: "Se um dia eu me matar", ts: now - 60_000 }], now });
    expect(t.kind).toBe("crise");
    expect(t.laugh).toBe("none");
    expect(t.stickers).toBe(false);
    // e rir depois disso não destrava zoeira
    expect(readTone("kkkk ok", { recentUserTexts: [{ text: "caso eu me suicidar", ts: now }], now }).laugh).toBe("none");
  });

  it("crise velha (horas atrás) não prende o tom pra sempre", () => {
    const now = Date.now();
    expect(readTone("bom dia", { recentUserTexts: [{ text: "quero me matar", ts: now - 8 * 3_600_000 }], now }).kind).toBe("normal");
  });

  it("risada: papo normal não ri; brincadeira espelha; rindo demais recente segura", () => {
    expect(readTone("oi, tudo bem?").laugh).toBe("none");
    expect(readTone("KKKKKK mentira").laugh).toBe("mirror");
    expect(readTone("kkkkk", { recentAssistantTexts: ["kkk", "aff kkk", "mds kkkk"] }).laugh).toBe("none");
  });

  it("bloco do prompt da crise fala do CVV e proíbe risada", () => {
    const lines = tonePromptLines(readTone("vou me matar")).join("\n");
    expect(lines).toMatch(/CRISE/);
    expect(lines).toMatch(/188/);
    expect(lines).toMatch(/proibida/);
  });
});

describe("governar risada e figurinha", () => {
  it("tira todas as risadas quando proibido e some bolha que era só risada", () => {
    expect(governLaughter(["Para de falar isso agora, Gabbis! Eu não vou deixar kkk", "kkkkkk", "mds kkkkkkkkk que isso KKKK"], { laugh: "none" })).toEqual([
      "Para de falar isso agora, Gabbis! Eu não vou deixar",
      "mds que isso"
    ]);
  });

  it("espelha: deixa só a primeira risada, no tamanho certo", () => {
    expect(governLaughter(["KKKKKKKKKKK mds", "vc é demais kkkk"], { laugh: "mirror", laughSize: 6 })).toEqual(["KKKKKK mds", "vc é demais"]);
  });

  it("em crise some figurinha e reação de risada", () => {
    const tone = readTone("caso eu me suicidar");
    const out = governActions(
      [{ type: "sticker", key: "teto-linguinha" }, { type: "message", text: "como eu vou esquecer de vc, boba kkk" }, { type: "react", emoji: "😂" }],
      tone
    );
    expect(out).toEqual([{ type: "message", text: "como eu vou esquecer de vc, boba" }]);
  });

  it("regulador: no máximo uma risada por resposta, até 6 k", () => {
    expect(regulateBubbles(["KKKKKKKKKKKKK mds", "vc é doida kkkk", "kkkkkk"]).texts).toEqual(["KKKKKK mds", "vc é doida"]);
    expect(stripLaughter("ahaha que isso rsrs kkk", { keep: 0 })).toBe("que isso");
  });
});

describe("pensar antes (rascunho)", () => {
  it("pensar(...) não vira ação nem vai pro histórico", () => {
    const raw = 'pensar("2 maçãs a R$3 (cada) = 6; mensagem(x) não é comando")\nmensagem("dá R$6 no total")';
    expect(parseActionCommands(raw)).toEqual([{ type: "message", text: "dá R$6 no total", quoteId: null }]);
    expect(stripThinkCommands(raw)).toBe('mensagem("dá R$6 no total")');
  });
});
