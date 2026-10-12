import { afterEach, describe, expect, it } from "vitest";
import {
  automateOutcomes,
  markRunForExplanation,
  registerAutomateRun,
  reportAutomateOutcome,
} from "../../src/integrations/automate/automateRunContext.js";
import { translateAutomateNotification } from "../../src/integrations/automate/eventTranslator.js";
import {
  buildAutomateOutcomePrompt,
  normalizeReplyTo,
  replyQuotePrefix,
} from "../../src/infra/api/routes/uiThreads.js";

const seen = [];
const listener = (o) => seen.push(o);
automateOutcomes.on("outcome", listener);
afterEach(() => {
  seen.length = 0;
});

function startRun(suffix, { explain }) {
  const runId = `run-test-${suffix}`;
  const instructionId = `ins-${suffix}`;
  registerAutomateRun({ instructionId, runId, threadId: `thread-${suffix}` });
  if (explain) markRunForExplanation(runId, `abrir o bloco de notas ${suffix}`);
  return { runId, instructionId, threadId: `thread-${suffix}` };
}

describe("resultado do AutoMate volta para a Teto explicar", () => {
  it("tarefa pedida pela Teto: ao concluir, emite o resultado com a conversa, a intenção e a resposta", () => {
    const { runId, instructionId, threadId } = startRun("a", { explain: true });
    const events = translateAutomateNotification("notifications/automate/task_completed", { instructionId, output: "Abri e digitei o texto." });
    expect(seen).toEqual([{ runId, threadId, status: "completed", output: "Abri e digitei o texto.", error: "", intent: "abrir o bloco de notas a" }]);
    // a resposta final também vai no evento da interface (o cartão mostra o que o AutoMate respondeu)
    expect(events[0]).toMatchObject({ type: "run.status", status: "completed", output: "Abri e digitei o texto." });
  });

  it("falha: emite failed com o erro e a saída parcial", () => {
    const { instructionId } = startRun("b", { explain: true });
    translateAutomateNotification("notifications/automate/error", { instructionId, error: "janela não abriu", output: "Tentei 2 vezes." });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: "failed", error: "janela não abriu", output: "Tentei 2 vezes." });
  });

  it("tarefa pedida direto pelo usuário (@automate) não vira explicação da Teto", () => {
    const { instructionId } = startRun("c", { explain: false });
    translateAutomateNotification("notifications/automate/task_completed", { instructionId, output: "ok" });
    expect(seen).toHaveLength(0);
  });

  it("só uma vez por execução, mesmo se a notificação repetir", () => {
    const { instructionId, runId } = startRun("d", { explain: true });
    translateAutomateNotification("notifications/automate/task_completed", { instructionId, output: "ok" });
    translateAutomateNotification("notifications/automate/task_completed", { instructionId, output: "ok" });
    expect(seen).toHaveLength(1);
    expect(reportAutomateOutcome({ runId, threadId: "x", status: "completed" })).toBe(false);
  });
});

describe("texto do evento enviado à Teto", () => {
  it("concluído: pede explicação do resultado, link de arquivo, sem agradecer nem criar tarefa", () => {
    const text = buildAutomateOutcomePrompt({ status: "completed", output: "Salvei em C:/x/a.docx", error: "", intent: "criar relatório" });
    expect(text).toContain("[EVENTO DO SISTEMA — resultado do AutoMate]");
    expect(text).toContain("«criar relatório»");
    expect(text).toContain("foi CONCLUÍDA");
    expect(text).toContain("Salvei em C:/x/a.docx");
    expect(text).toContain("[nome](file:///…)");
    expect(text).toContain("NÃO é uma mensagem do usuário");
    expect(text).toContain("NÃO dispare novas tarefas");
  });

  it("falha: pede o motivo em linguagem simples e o que fazer", () => {
    const text = buildAutomateOutcomePrompt({ status: "failed", output: "", error: "janela não abriu", intent: "" });
    expect(text).toContain("FALHOU");
    expect(text).toContain("Erro informado: janela não abriu");
    expect(text).toContain("(o AutoMate não devolveu texto)");
    expect(text).toContain("o que ele pode fazer");
  });
});

describe("responder a uma mensagem (replyTo)", () => {
  it("normaliza a citação do app e limita o tamanho", () => {
    expect(normalizeReplyTo({ id: "m1", role: "assistant", text: "  Abri o Bloco de Notas.  " })).toEqual({ id: "m1", role: "assistant", text: "Abri o Bloco de Notas." });
    expect(normalizeReplyTo({ id: "m2", role: "user", text: "x".repeat(5000) }).text).toHaveLength(1500);
    expect(normalizeReplyTo({ role: "papel-estranho", text: "oi" })).toEqual({ id: "", role: "user", text: "oi" });
  });

  it("ignora citação vazia ou inválida", () => {
    for (const bad of [null, undefined, "x", 3, {}, { text: "   " }, { text: 5 }]) expect(normalizeReplyTo(bad)).toBeNull();
  });

  it("no modo AutoMate o trecho citado entra no texto da tarefa", () => {
    expect(replyQuotePrefix({ id: "m1", role: "assistant", text: "o relatório 3" })).toBe("[O usuário está respondendo a uma mensagem da Teto: «o relatório 3»]\n");
    expect(replyQuotePrefix({ id: "m2", role: "user", text: "faz isso" })).toContain("uma mensagem dele(a)");
  });
});

// o listener global é só para estes testes
process.on("exit", () => automateOutcomes.off("outcome", listener));
