import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/core/agent/agent.js";
import { ShortTermMemory } from "../../src/core/memory/shortTerm.js";
import { LongTermMemory } from "../../src/core/memory/longTerm.js";
import { ContextBuilder } from "../../src/core/memory/contextBuilder.js";
import { DEFAULTS } from "../../src/infra/config/defaults.js";
import { loadCharacter, loadPersonality } from "../../src/core/personality/index.js";

let agent;
let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tetos-ui-prompt-"));
  const shortTerm = new ShortTermMemory(20, { persistPath: join(dir, "short.json") });
  const longTerm = new LongTermMemory(join(dir, "long.json"));
  agent = new Agent({
    personality: loadPersonality(DEFAULTS.personalityPath),
    character: loadCharacter(DEFAULTS.characterPath),
    shortTerm,
    longTerm,
    brain: {},
    contextBuilder: new ContextBuilder(longTerm),
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const prompt = (meta) => {
  const out = agent.buildPrompt("oi", { shortTerm: [], longTerm: [], mediumTerm: [] }, meta);
  return Array.isArray(out) ? out.join("\n") : String(out);
};

describe("prompt da Teto no app (ui-desktop)", () => {
  it("sabe que pode usar Markdown e como citar arquivos com link file:///", () => {
    const p = prompt({ channelId: "ui-desktop", sessionId: "t1" });
    expect(p).toContain("[FORMATO — app AutoMate/TetOS]");
    expect(p).toContain("**Markdown**");
    expect(p).toContain("file:///C:/Users/Nome/Desktop/relatorio.docx");
    expect(p).toContain("NUNCA invente caminho");
  });

  it("outros canais (WhatsApp) não recebem a orientação de Markdown", () => {
    expect(prompt({ channelId: "direct:5511", sessionId: "t2" })).not.toContain("[FORMATO — app AutoMate/TetOS]");
  });

  it("a citação do app vira contexto: a resposta se refere à mensagem marcada", () => {
    const p = prompt({ channelId: "ui-desktop", sessionId: "t3", quotedMessage: "Criei o relatório de vendas e a planilha de custos.", isReply: true, isReplyToBot: true });
    expect(p).toContain("[REPLY / QUOTE]");
    expect(p).toContain("Criei o relatório de vendas e a planilha de custos.");
    expect(p).toContain("o que escreveu agora se refere a ELA");
    expect(p).not.toContain("a resposta no WhatsApp deve citar");
  });

  it("no WhatsApp a orientação de citação continua a de sempre", () => {
    const p = prompt({ channelId: "direct:5511", sessionId: "t4", quotedMessage: "oi", isReply: true });
    expect(p).toContain("a resposta no WhatsApp deve citar");
  });
});
