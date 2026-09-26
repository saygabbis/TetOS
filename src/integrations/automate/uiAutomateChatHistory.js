import {
  bindRunToThread,
  resolveThreadIdForRun,
  resolveAutomateRun,
} from "./automateRunContext.js";

function threadIdForAutomateRun(runId) {
  if (!runId) return null;
  const direct = resolveThreadIdForRun(runId);
  if (direct) return direct;
  const resolved = resolveAutomateRun({ instructionId: runId });
  if (resolved.threadId && resolved.runId?.startsWith("run-")) {
    return resolved.threadId;
  }
  return resolveThreadIdForRun(resolved.runId) ?? resolved.threadId;
}

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

function upsertThreadMessage({
  threadStore,
  persistThreadStore,
  uiBus,
  threadId,
  message,
  skipPublish = false,
}) {
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
  if (skipPublish) return;
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

    if (
      event.type === "message.delta" &&
      event.threadId &&
      event.messageId?.endsWith("-thinking")
    ) {
      const runId = event.messageId.slice("auto-".length, -"-thinking".length);
      const threadId = event.threadId;
      const thread = threadStore.get(threadId);
      const existing = thread?.messages?.find((m) => m.id === event.messageId);
      const nextText = `${existing?.text ?? ""}${event.text ?? ""}`;
      upsertThreadMessage({
        threadStore,
        persistThreadStore,
        uiBus,
        threadId,
        message: {
          id: event.messageId,
          role: "assistant",
          text: nextText,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          meta: {
            automate: { kind: "thinking", runId },
          },
        },
        skipPublish: true,
      });
      return;
    }

    if (event.type === "plan.started" && event.runId && event.threadId) {
      const thread = threadStore.get(event.threadId);
      const runningRun = thread?.messages?.find(
        (m) => m.meta?.automate?.kind === "run" && m.meta?.automate?.status === "running",
      );
      bindRunToThread(event.runId, event.threadId);
      if (
        runningRun &&
        runningRun.meta?.automate?.runId &&
        runningRun.meta.automate.runId !== event.runId
      ) {
        return;
      }
      upsertThreadMessage({
        threadStore,
        persistThreadStore,
        uiBus,
        threadId: event.threadId,
        message: {
          id: `auto-${event.runId}-start`,
          role: "assistant",
          text: `AutoMate · ${event.title ?? "executando"}`,
          createdAt: runningRun?.createdAt ?? new Date().toISOString(),
          meta: {
            automate: {
              kind: "run",
              runId: event.runId,
              status: "running",
            },
          },
        },
        skipPublish: true,
      });
      return;
    }

    if (event.type === "plan.step" && event.runId && event.step) {
      const threadId = threadIdForAutomateRun(event.runId);
      if (!threadId) return;
      const step = event.step;
      const clientRunId = resolveAutomateRun({ instructionId: event.runId }).runId;
      const runId = String(clientRunId).startsWith("run-") ? clientRunId : event.runId;
      upsertThreadMessage({
        threadStore,
        persistThreadStore,
        uiBus,
        threadId,
        message: {
          id: `auto-${runId}-${step.id}`,
          role: "assistant",
          text: formatStepText(step),
          createdAt: new Date().toISOString(),
          meta: {
            automate: {
              kind: "step",
              runId,
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
      const mapped = resolveAutomateRun({ instructionId: event.runId });
      const runId = String(mapped.runId).startsWith("run-") ? mapped.runId : event.runId;
      const threadId = resolveThreadIdForRun(runId) ?? mapped.threadId;
      if (!threadId) return;
      if (event.status === "running") {
        upsertThreadMessage({
          threadStore,
          persistThreadStore,
          uiBus,
          threadId,
          message: {
            id: `auto-${runId}-start`,
            role: "assistant",
            text: "AutoMate · executando no computador…",
            createdAt: new Date().toISOString(),
            meta: {
              automate: { kind: "run", runId, status: "running" },
            },
          },
        });
        return;
      }

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
          id: `auto-${runId}-end`,
          role: "assistant",
          text,
          createdAt: new Date().toISOString(),
          meta: {
            automate: {
              kind: "run_end",
              runId,
              status: event.status,
              error: event.error,
            },
          },
        },
      });
    }
  });
}
