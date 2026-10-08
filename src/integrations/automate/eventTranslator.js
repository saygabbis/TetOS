import { resolveAutomateRun } from "./automateRunContext.js";
import {
  USER_FACING_AUTOMATE_TOOLS,
  emitUtteranceLog,
  textFromToolCall,
} from "./automateUtterance.js";

const PROTOCOL_VERSION = 1;

const thinkingBuffer = new Map();

function flushThinking(runId, uiBus) {
  const buf = thinkingBuffer.get(runId);
  if (!buf) return;
  thinkingBuffer.delete(runId);
  if (!buf.lines.length) return;
  const line = buf.lines.join("\n");
  uiBus?.publish({
    type: "tool.log",
    runId,
    stepId: "active",
    line,
    level: "info",
    at: new Date().toISOString(),
  });
}

/**
 * Converte notificações MCP do AutoMate em eventos do protocolo da UI.
 * @param {string} method
 * @param {object} params
 * @param {{ uiBus?: { publish: (e: object) => void } }} [options]
 */
export function translateAutomateNotification(method, params, options = {}) {
  if (!method?.startsWith("notifications/automate/")) {
    return [];
  }
  const suffix = method.slice("notifications/automate/".length);
  const { runId, threadId } = resolveAutomateRun(params);

  switch (suffix) {
    case "tool_call": {
      const tool = params?.tool ?? "tool";
      const status = params?.status;
      const state =
        status === "start" ? "running" : params?.success === false ? "failed" : "done";
      const events = [
        {
          type: "plan.step",
          runId,
          step: {
            id: `${tool}-${params?.turnId ?? "0"}`,
            index: 0,
            tool,
            title: tool,
            state,
            args: params?.args ? JSON.stringify(params.args) : undefined,
          },
        },
      ];
      if (USER_FACING_AUTOMATE_TOOLS.has(tool) && status !== "start") {
        const line = textFromToolCall(tool, params);
        const suffix = params?.turnId ?? params?.id ?? "";
        const utterance = emitUtteranceLog(runId, tool, line, "info", suffix);
        if (utterance) events.push(utterance);
      }
      return events;
    }
    case "user_feedback": {
      const u = emitUtteranceLog(runId, "user_feedback", params?.message);
      return u ? [u] : [];
    }
    case "notify": {
      const u = emitUtteranceLog(runId, "notify", params?.message, params?.level ?? "info");
      return u ? [u] : [];
    }
    case "verify_result": {
      const observed = params?.observed ?? params?.message ?? "";
      const ok = params?.success !== false;
      const text =
        String(observed).trim() || (ok ? "Objetivo verificado." : "Verificação não passou.");
      const u = emitUtteranceLog(
        runId,
        "verify_result",
        text,
        ok ? "info" : "warn",
      );
      return u ? [u] : [];
    }
    case "thinking": {
      const line = params?.message ?? params?.text;
      if (!line || typeof line !== "string") return [];
      const uiBus = options.uiBus;
      if (params?.streaming && uiBus && threadId) {
        uiBus.publish({
          type: "message.delta",
          threadId,
          messageId: `auto-${runId}-thinking`,
          text: line,
        });
        return [];
      }
      if (uiBus) {
        let buf = thinkingBuffer.get(runId);
        if (!buf) {
          buf = { lines: [], timer: null };
          thinkingBuffer.set(runId, buf);
        }
        buf.lines.push(line);
        if (buf.timer) clearTimeout(buf.timer);
        buf.timer = setTimeout(() => flushThinking(runId, uiBus), 200);
        return [];
      }
      return [
        {
          type: "tool.log",
          runId,
          stepId: "active",
          line,
          level: "info",
          at: new Date().toISOString(),
        },
      ];
    }
    case "clarification_needed": {
      const kind = params?.kind ?? "question";
      const isManual = kind === "manual_action" || kind === "action";
      const question =
        params?.questions?.[0]?.prompt ??
        params?.question ??
        params?.prompt ??
        "Confirma esta ação?";
      const requestId = params?.id ?? `perm-${Date.now()}`;
      const channel = isManual ? "request_user_takeover" : "ask_user";
      const utterance = emitUtteranceLog(runId, channel, question, "info", requestId);
      if (isManual) {
        return [
          ...(utterance ? [utterance] : []),
          {
            type: "control.request",
            runId,
            request: { id: requestId, question },
          },
        ];
      }
      return [
        ...(utterance ? [utterance] : []),
        {
          type: "permission.request",
          runId,
          request: { id: requestId, question },
        },
      ];
    }
    case "task_progress":
      if (params?.status === "queued") {
        return [
          {
            type: "tool.log",
            runId,
            stepId: "queue",
            line: "Na fila do AutoMate…",
            level: "info",
            at: new Date().toISOString(),
          },
        ];
      }
      return [{ type: "run.status", runId, status: "running" }];
    case "task_completed":
      return [
        { type: "run.status", runId, status: "completed" },
        { type: "presence", state: "awake", label: "acordada" },
      ];
    case "error":
      return [
        {
          type: "run.status",
          runId,
          status: "failed",
          error: params?.error ?? "erro",
        },
        { type: "presence", state: "awake", label: "acordada" },
      ];
    case "turn_started":
      return [{ type: "presence", state: "on_computer", label: "Teto está no computador" }];
    default:
      return [];
  }
}

export function getProtocolVersion() {
  return PROTOCOL_VERSION;
}
