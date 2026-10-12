import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/core/agent/agent.js";
import { ShortTermMemory } from "../../src/core/memory/shortTerm.js";
import { LongTermMemory } from "../../src/core/memory/longTerm.js";
import { ContextBuilder } from "../../src/core/memory/contextBuilder.js";
import { DEFAULTS } from "../../src/infra/config/defaults.js";
import { loadCharacter, loadPersonality } from "../../src/core/personality/index.js";
import { slimMetaForStorage } from "../../src/core/memory/slimMeta.js";
import { HubAgentLink } from "../../src/integrations/automate-hub/hubAgentLink.js";
import { automateOutcomes, markRunForExplanation, reportAutomateOutcome } from "../../src/integrations/automate/automateRunContext.js";
import { translateAutomateNotification } from "../../src/integrations/automate/eventTranslator.js";
import { buildAutomateOutcomePrompt } from "../../src/infra/api/routes/uiThreads.js";
import {
  formatArtifactsLines,
  formatAutomateRunsBlock,
  normalizeArtifactRefs,
  normalizeAutomateRuns,
} from "../../src/integrations/automate/automateRunsContext.js";

const run = (over = {}) => ({ title: "gera o relatório", status: "running", deviceName: "Casa", startedAt: "2026-01-10T17:02:00Z", ...over });
const shot = { id: "a1", kind: "image", name: "prova.jpg", mimeType: "image/jpeg", size: 4200, caption: "Arquivo **salvo**" };
const doc = { id: "a2", kind: "file", name: "relatorio.pdf", mimeType: "application/pdf", size: 1_200_000 };

describe("execuções do AutoMate na conversa", () => {
  it("normaliza: só campos usados, tamanho limitado, sem título descarta, no máximo 5 (as mais recentes)", () => {
    expect(normalizeAutomateRuns(undefined)).toEqual([]);
    expect(normalizeAutomateRuns([{ status: "running" }, null, "x"])).toEqual([]);
    const many = Array.from({ length: 9 }, (_, n) => run({ title: `tarefa ${n}`, extra: "ignorado" }));
    const out = normalizeAutomateRuns(many);
    expect(out.map((r) => r.title)).toEqual(["tarefa 4", "tarefa 5", "tarefa 6", "tarefa 7", "tarefa 8"]);
    expect(out[0]).not.toHaveProperty("extra");
    expect(normalizeAutomateRuns([run({ title: "x".repeat(500) })])[0].title).toHaveLength(120);
  });

  it("uma linha por execução com estado, PC e horário; erro só na que falhou; vazio não gasta contexto", () => {
    const lines = formatAutomateRunsBlock([
      run(),
      run({ title: "abre o bloco", status: "completed", endedAt: "2026-01-10T17:05:00Z" }),
      run({ title: "exporta", status: "failed", endedAt: "2026-01-10T17:06:00Z", error: "janela não abriu" }),
    ]).join("\n");
    expect(lines).toContain("[EXECUÇÕES DO AUTOMATE NESTA CONVERSA]");
    expect(lines).toContain('- «gera o relatório» — em andamento no PC "Casa" (desde 14:02)');
    expect(lines).toContain('- «abre o bloco» — concluída no PC "Casa" (14:05)');
    expect(lines).toContain('- «exporta» — falhou no PC "Casa" (14:06): janela não abriu');
    expect(lines).toContain("não abra uma tarefa nova só para olhar");
    expect(formatAutomateRunsBlock([])).toEqual([]);
    expect(formatAutomateRunsBlock(undefined)).toEqual([]);
  });
});

describe("anexos da tarefa", () => {
  it("referências sem conteúdo: nome, tipo, tamanho e legenda; descarta o que não for imagem/arquivo e corta no máximo", () => {
    expect(normalizeArtifactRefs([{ ...shot, data: "SEVMTE8=" }, { kind: "video", name: "x.mp4" }, { kind: "file" }, null, doc])).toEqual([
      { kind: "image", name: "prova.jpg", size: 4200, caption: "Arquivo **salvo**" },
      { kind: "file", name: "relatorio.pdf", size: 1_200_000 },
    ]);
    expect(normalizeArtifactRefs(Array.from({ length: 12 }, (_, n) => ({ ...doc, name: `f${n}.pdf` })))).toHaveLength(8);
  });

  it("linhas do prompt: lista com tamanho e legenda, avisa que o app já mostra e que ela não viu o conteúdo", () => {
    const text = formatArtifactsLines([shot, doc]).join("\n");
    expect(text).toContain("- prova.jpg (imagem, 4 KB) — legenda: Arquivo **salvo**");
    expect(text).toContain("- relatorio.pdf (arquivo, 1,1 MB)");
    expect(text).toContain("NÃO reenvia");
    expect(text).toContain("não o invente");
    expect(formatArtifactsLines([])).toEqual([]);
    expect(formatArtifactsLines(undefined)).toEqual([]);
  });

  it("o prompt do resultado inclui os anexos; sem anexos fica igual a antes", () => {
    const base = { status: "completed", output: "Salvei o relatório.", error: "", intent: "gera o relatório" };
    expect(buildAutomateOutcomePrompt({ ...base, artifacts: [doc] })).toContain("relatorio.pdf (arquivo, 1,1 MB)");
    expect(buildAutomateOutcomePrompt(base)).not.toContain("Anexos desta tarefa");
  });

  it("o fim da execução (via hub) leva as referências ao resultado explicado pela Teto", () => {
    const seen = [];
    const listener = (o) => seen.push(o);
    automateOutcomes.on("outcome", listener);
    try {
      markRunForExplanation("run-art", "gera o relatório");
      translateAutomateNotification("notifications/automate/task_completed", { runId: "run-art", threadId: "th", output: "ok", artifacts: [{ ...shot, data: "SEVMTE8=" }, doc] }, {});
      // sem run conhecido o tradutor não emite; chama direto para garantir o formato do evento
      markRunForExplanation("run-art2", "x");
      reportAutomateOutcome({ runId: "run-art2", threadId: "th", status: "completed", output: "ok", artifacts: [{ ...shot, data: "SEVMTE8=" }, doc] });
    } finally {
      automateOutcomes.off("outcome", listener);
    }
    const outcome = seen.find((o) => o.runId === "run-art2");
    expect(outcome.artifacts).toEqual([
      { kind: "image", name: "prova.jpg", size: 4200, caption: "Arquivo **salvo**" },
      { kind: "file", name: "relatorio.pdf", size: 1_200_000 },
    ]);
    expect(JSON.stringify(outcome)).not.toContain("SEVMTE8=");
  });
});

describe("mensagem do hub com as execuções da conversa", () => {
  const make = () => {
    const dispatchUiRequest = vi.fn(async () => ({ status: 202, headers: {}, body: "{}" }));
    const link = new HubAgentLink({
      config: { url: "ws://x/agent-link", agentId: "tetos", token: "t", capabilities: ["chat"] },
      dispatchUiRequest,
      uiBus: { publish: () => undefined, subscribe: () => () => undefined },
      onLog: () => undefined,
      onError: () => undefined,
    });
    return { link, dispatchUiRequest };
  };

  it("encaminha `runs` à conversa; sem execuções não manda o campo", async () => {
    const { link, dispatchUiRequest } = make();
    await link.handleHubMessage({ t: "message", threadId: "th1", message: { text: "como está?" }, runs: [run()] });
    await link.handleHubMessage({ t: "message", threadId: "th1", message: { text: "oi" } });
    expect(dispatchUiRequest.mock.calls[0][0].body).toEqual({ text: "como está?", runs: [run()] });
    expect(dispatchUiRequest.mock.calls[1][0].body).toEqual({ text: "oi" });
  });
});

describe("prompt da Teto no app", () => {
  let agent;
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tetos-runs-prompt-"));
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

  it("no app: sabe do Markdown, dos anexos no cartão e das execuções da conversa", () => {
    const p = prompt({ channelId: "ui-desktop", sessionId: "t1", automateRuns: [run()] });
    expect(p).toContain("**Markdown**");
    expect(p).toContain("ANEXOS: prints e arquivos que o AutoMate entrega aparecem no cartão da tarefa");
    expect(p).toContain("[EXECUÇÕES DO AUTOMATE NESTA CONVERSA]");
    expect(p).toContain('em andamento no PC "Casa"');
  });

  it("sem execuções o bloco não aparece; fora do app (WhatsApp) nada disso vai", () => {
    expect(prompt({ channelId: "ui-desktop", sessionId: "t1" })).not.toContain("[EXECUÇÕES DO AUTOMATE");
    const wa = prompt({ channelId: "5511@s.whatsapp.net", sessionId: "t1", automateRuns: [run()] });
    expect(wa).not.toContain("[EXECUÇÕES DO AUTOMATE");
    expect(wa).not.toContain("ANEXOS: prints");
  });

  it("as execuções não vão para a memória (meta enxuta só guarda o essencial)", () => {
    expect(slimMetaForStorage({ channelId: "ui-desktop", automateRuns: [run()] })).toEqual({ channelId: "ui-desktop" });
  });
});
