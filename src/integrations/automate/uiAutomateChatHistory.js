import { bindRunToThread, resolveThreadIdForRun } from "./automateRunContext.js";

function stepPrefix(state) {
  switch (state) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "…";
    default:
      return "○";
  }
}

function formatStepText(step) {
  const label = step?.title || step?.tool || "passo";
  return `${stepPrefix(step?.state)} ${label}`;
}

function upsertThreadMessage({ threadStore, persistThreadStore, uiBus, threadId, message }) {
  const thread = threadStore.get(threadId);
  if (!thread) return;

  const messages = thread.messages ?? [];
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx >= 0) {
    const prev = messages[idx];
    messages[idx] = {
      ...prev,
      ...message,
      createdAt: prev.createdAt ?? message.createdAt,
      meta: { ...(prev.meta ?? {}), ...(message.meta ?? {}) },
    };
  } else {
    messages.push(message);
  }
  thread.messages = messages;
  thread.updatedAt = new Date().toISOString();
  persistThreadStore(threadStore);
  const saved = messages.find((m) => m.id === message.id);
  uiBus.publish({ type: "message.final", threadId, message: saved ?? message });
}

/**
 * Grava passos e status do AutoMate no histórico da conversa UI (thread.messages).
 */
export function attachAutomateChatHistory(uiBus, { threadStore, persistThreadStore }) {
  uiBus.on("event", (envelope) => {
    const event = envelope?.event;
    if (!event?.type) return;

    if (event.type === "plan.started" && event.runId && event.threadId) {
      bindRunToThread(event.runId, event.threadId);
      upsertThreadMessage({
        threadStore,
        persistThreadStore,
        uiBus,
        threadId: event.threadId,
        message: {
          id: `auto-${event.runId}-start`,
          role: "assistant",
          text: `AutoMate · ${event.title ?? "executando"}`,
          createdAt: new Date().toISOString(),
          meta: {
            automate: {
              kind: "run",
              runId: event.runId,
              status: "running",
            },
          },
        },
      });
      return;
    }

    if (event.type === "plan.step" && event.runId && event.step) {
      const threadId = resolveThreadIdForRun(event.runId);
      if (!threadId) return;
      const step = event.step;
      upsertThreadMessage({
        threadStore,
        persistThreadStore,
        uiBus,
        threadId,
        message: {
          id: `auto-${event.runId}-${step.id}`,
          role: "assistant",
          text: formatStepText(step),
          createdAt: new Date().toISOString(),
          meta: {
            automate: {
              kind: "step",
              runId: event.runId,
              step: { ...step },
            },
          },
        },
      });
      return;
    }

    if (event.type === "tool.log" && event.runId && event.line) {
      const threadId = resolveThreadIdForRun(event.runId);
      if (!threadId) return;
      const msgId = `auto-${event.runId}-${event.stepId ?? "active"}`;
      const thread = threadStore.get(threadId);
      const existing = thread?.messages?.find((m) => m.id === msgId);
      const logs = [...(existing?.meta?.automate?.logs ?? []), event.line];
      upsertThreadMessage({
        threadStore,
        persistThreadStore,
        uiBus,
        threadId,
        message: {
          id: msgId,
          role: "assistant",
          text: existing?.text ?? "AutoMate · detalhes",
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          meta: {
            automate: {
              kind: "log",
              runId: event.runId,
              stepId: event.stepId,
              logs,
            },
          },
        },
      });
      return;
    }

    if (event.type === "run.status" && event.runId) {
      const threadId = resolveThreadIdForRun(event.runId);
      if (!threadId) return;
      if (event.status === "running") return;

      const text =
        event.status === "completed"
          ? "AutoMate · concluído"
          : `AutoMate · falhou${event.error ? `: ${event.error}` : ""}`;

      upsertThreadMessage({
        threadStore,
        persistThreadStore,
        uiBus,
        threadId,
        message: {
          id: `auto-${event.runId}-end`,
          role: "assistant",
          text,
          createdAt: new Date().toISOString(),
          meta: {
            automate: {
              kind: "run_end",
              runId: event.runId,
              status: event.status,
              error: event.error,
            },
          },
        },
      });
    }
  });
}
