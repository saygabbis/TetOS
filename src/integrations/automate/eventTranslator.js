import { reportAutomateOutcome, resolveAutomateRun } from "./automateRunContext.js";
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
 * Como a UI deve coletar a resposta, conforme o tipo da pergunta do AutoMate: texto livre vira campo de texto,
 * escolha vira chips com os ids reais das opções (ex.: approve/deny do gate de aprovação).
 * Sem tipo conhecido devolve {} e a UI cai no Confirmar/Negar.
 */
function permissionInputFromQuestion(question) {
  const options = Array.isArray(question?.options)
    ? question.options
        .filter((o) => o && typeof o.id === "string" && typeof o.label === "string")
        .map((o) => ({ id: o.id, label: o.label }))
    : [];
  if (question?.type === "free_text") return { input: "text" };
  if ((question?.type === "single_choice" || question?.type === "multiple_choice") && options.length) {
    return { input: "choice", options, ...(question.type === "multiple_choice" ? { multiple: true } : {}) };
  }
  return {};
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
  const resolved = resolveAutomateRun(params);
  if (!resolved) {
    return [];
  }
  const { runId, threadId } = resolved;

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
          request: { id: requestId, question, ...permissionInputFromQuestion(params?.questions?.[0]) },
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
      reportAutomateOutcome({ runId, threadId, status: "completed", output: params?.output, artifacts: params?.artifacts });
      return [
        { type: "run.status", runId, status: "completed", ...(params?.output ? { output: String(params.output) } : {}) },
        { type: "presence", state: "awake", label: "acordada" },
      ];
    case "error":
      reportAutomateOutcome({ runId, threadId, status: "failed", output: params?.output, error: params?.error ?? "erro", artifacts: params?.artifacts });
      return [
        {
          type: "run.status",
          runId,
          status: "failed",
          error: params?.error ?? "erro",
          ...(params?.output ? { output: String(params.output) } : {}),
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
