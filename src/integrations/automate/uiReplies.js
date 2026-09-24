import { bindRunToThread, registerAutomateRun } from "./automateRunContext.js";

function parseInstructionFromEnqueueResult(result) {
  const content = result?.content;
  if (!Array.isArray(content) || !content[0]?.text) return null;
  const text = content[0].text;
  try {
    const parsed = JSON.parse(text);
    return parsed?.id ?? parsed?.instructionId ?? null;
  } catch {
    return null;
  }
}

function publishAutomateRunStarted(uiBus, { runId, threadId }) {
  uiBus.publish({
    type: "plan.started",
    runId,
    threadId,
    title: "Plano",
  });
  uiBus.publish({
    type: "presence",
    state: "on_computer",
    label: "Teto está no computador",
  });
}

function publishAutomateFailure(uiBus, thread, { runId, message }) {
  uiBus.publish({
    type: "run.status",
    runId,
    status: "failed",
    error: message,
  });
  const assistantMsg = {
    id: `a-err-${Date.now()}`,
    role: "assistant",
    text: `Não consegui falar com o computador: ${message}`,
    createdAt: new Date().toISOString(),
  };
  thread.messages.push(assistantMsg);
  thread.updatedAt = new Date().toISOString();
  uiBus.publish({ type: "message.final", threadId: thread.id, message: assistantMsg });
}

/**
 * Aplica ações da Teto (mensagem, computador, etc.) no contexto da UI desktop.
 */
export async function applyUiOutgoingActions({
  replies,
  thread,
  uiBus,
  automateClient,
}) {
  const actions = Array.isArray(replies?.actions) ? replies.actions : [];
  const fallbackTexts = Array.isArray(replies)
    ? replies.filter((r) => typeof r === "string" && r.trim())
    : [];

  if (actions.length === 0 && fallbackTexts.length > 0) {
    const assistantMsg = {
      id: `a-${Date.now()}`,
      role: "assistant",
      text: fallbackTexts.join("\n"),
      createdAt: new Date().toISOString(),
    };
    thread.messages.push(assistantMsg);
    thread.updatedAt = new Date().toISOString();
    uiBus.publish({ type: "message.final", threadId: thread.id, message: assistantMsg });
    return;
  }

  for (const action of actions) {
    if (action.type === "message" && action.text) {
      const assistantMsg = {
        id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        text: action.text,
        createdAt: new Date().toISOString(),
      };
      thread.messages.push(assistantMsg);
      thread.updatedAt = new Date().toISOString();
      uiBus.publish({ type: "message.final", threadId: thread.id, message: assistantMsg });
      continue;
    }

    if (action.type === "automate" && action.intent) {
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      bindRunToThread(runId, thread.id);
      publishAutomateRunStarted(uiBus, { runId, threadId: thread.id });
      try {
        const result = await automateClient.enqueue(action.intent, undefined, {
          threadId: thread.id,
          runId,
        });
        const instructionId = parseInstructionFromEnqueueResult(result);
        if (instructionId) {
          registerAutomateRun({ instructionId, runId, threadId: thread.id });
        }
      } catch (err) {
        const message = err?.message ?? "falha ao enfileirar";
        publishAutomateFailure(uiBus, thread, { runId, message });
      }
    }
  }
}
