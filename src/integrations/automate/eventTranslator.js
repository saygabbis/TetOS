import { reportAutomateOutcome, resolveAutomateRun } from "./automateRunContext.js";
import {
  USER_FACING_AUTOMATE_TOOLS,
  emitUtteranceLog,
  textFromToolCall,
} from "./automateUtterance.js";

const PROTOCOL_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Referências que o app consegue baixar. Conteúdo (`data`) e itens sem id ficam de fora para não invalidar o evento. */
function uiArtifactRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, 8)) {
    if (!a || typeof a.id !== "string" || !UUID_RE.test(a.id)) continue;
    if ((a.kind !== "image" && a.kind !== "file") || typeof a.mimeType !== "string" || typeof a.size !== "number") continue;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 120) : "arquivo";
    const caption = typeof a.caption === "string" && a.caption.trim() ? a.caption.trim().slice(0, 300) : "";
    out.push({
      id: a.id,
      kind: a.kind,
      name,
      mimeType: a.mimeType,
      size: a.size,
      ...(caption ? { caption } : {}),
      ...(typeof a.width === "number" ? { width: a.width } : {}),
      ...(typeof a.height === "number" ? { height: a.height } : {}),
    });
  }
  return out;
}

const thinkingBuffer = new Map();

/** Fases do `think()` que são bastidores: não viram log na tela. */
const NOISE_PHASES = new Set([
  "modo autônomo",
  "objetivo",
  "mcp",
  "planejamento",
  "grounding",
  "goal verify",
  "experience review",
  "conclusão",
]);

const PLAN_STATUSES = new Set(["pending", "in_progress", "done", "blocked"]);

function isNoiseThinking(params) {
  const phase = typeof params?.phase === "string" ? params.phase.trim().toLowerCase() : "";
  if (NOISE_PHASES.has(phase)) return true;
  const line = String(params?.message ?? params?.text ?? "").trim();
  if (/^Raciocinando/i.test(line)) return true;
  if (/sem perguntas|inferir e decidir|modo autônomo/i.test(line)) return true;
  if (line === "memória, tools e contexto prontos") return true;
  return false;
}

/** Checklist de `notifications/automate/plan`, saneada antes de ir ao app. */
function planItemsOf(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v.slice(0, 30)) {
    if (!raw || typeof raw !== "object") continue;
    const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 200) : "";
    if (!text) continue;
    const status = typeof raw.status === "string" && PLAN_STATUSES.has(raw.status) ? raw.status : "pending";
    const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim().slice(0, 200) : undefined;
    out.push({
      text,
      status,
      ...(reason ? { reason } : {}),
      ...(raw.mechanical === true ? { mechanical: true } : {}),
    });
  }
  return out;
}

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
const FORM_FIELD_TYPES = new Set(["text", "textarea", "email", "cpf", "cnpj", "phone", "cep", "number", "date", "select"]);

/** Formulário do AutoMate (`ask_user_form`): cada pergunta é um campo; o id dela é a chave do valor. */
export function formFieldsFromQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((q) => {
    if (!q || typeof q.id !== "string" || typeof q.prompt !== "string") return [];
    const options = Array.isArray(q.options)
      ? q.options.filter((o) => o && typeof o.id === "string" && typeof o.label === "string").map((o) => ({ id: o.id, label: o.label }))
      : [];
    const raw = typeof q.input === "string" ? q.input : options.length ? "select" : "text";
    return [
      {
        key: q.id,
        label: q.prompt,
        type: FORM_FIELD_TYPES.has(raw) ? raw : "text",
        required: q.required !== false,
        ...(typeof q.placeholder === "string" && q.placeholder ? { placeholder: q.placeholder } : {}),
        ...(options.length ? { options } : {}),
      },
    ];
  });
}

function permissionInputFromQuestion(question) {
  const options = Array.isArray(question?.options)
    ? question.options
        .filter((o) => o && typeof o.id === "string" && typeof o.label === "string")
        .map((o) => ({ id: o.id, label: o.label }))
    : [];
  const suggestions = Array.isArray(question?.suggestions)
    ? question.suggestions.filter((x) => typeof x === "string" && x.trim()).slice(0, 6)
    : [];
  if (question?.type === "free_text") return { input: "text", ...(suggestions.length ? { suggestions } : {}) };
  if ((question?.type === "single_choice" || question?.type === "multiple_choice") && options.length) {
    return { input: "choice", options, ...(question.type === "multiple_choice" ? { multiple: true } : {}) };
  }
  return {};
}

/** Saída curta de uma tool que falhou, para o log do passo. */
function failureLogs(params) {
  if (params?.success !== false || params?.status === "start") return undefined;
  const output = typeof params?.output === "string" ? params.output.replace(/\s+/g, " ").trim() : "";
  if (!output) return undefined;
  return [output.length > 400 ? `${output.slice(0, 400)}…` : output];
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
      const logs = failureLogs(params);
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
            ...(logs ? { logs } : {}),
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
    case "plan": {
      const items = planItemsOf(params?.items);
      if (items.length === 0) return [];
      return [{ type: "automate.plan", runId, items }];
    }
    case "thinking": {
      if (isNoiseThinking(params)) return [];
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
      const isManual = kind === "manual_action" || kind === "action" || kind === "takeover";
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
            // Intervenção manual: o usuário faz (login, senha, CAPTCHA) e responde "já fiz" ou "desisto" (ids do AutoMate).
            request: {
              id: requestId,
              title: question,
              detail: "",
              question,
              input: "takeover",
              options: [
                { id: "done", label: "Pronto, já fiz" },
                { id: "refuse", label: "Não quero fazer / desistir" },
              ],
            },
          },
        ];
      }
      if (kind === "form") {
        return [
          ...(utterance ? [utterance] : []),
          {
            type: "permission.request",
            runId,
            request: {
              id: requestId,
              question: typeof params?.context === "string" && params.context.trim() ? params.context : question,
              input: "form",
              fields: formFieldsFromQuestions(params?.questions),
            },
          },
        ];
      }
      // Aprovação de ação sensível: Aprovar/Negar (com os ids que o AutoMate mandou, se vierem).
      const approvalOptions = (params?.questions?.[0]?.options ?? []).filter((o) => o && typeof o.id === "string" && typeof o.label === "string");
      const approval = kind === "approval" ? { input: "approval", ...(approvalOptions.length ? { options: approvalOptions.map((o) => ({ id: o.id, label: o.label })) } : {}) } : null;
      return [
        ...(utterance ? [utterance] : []),
        {
          type: "permission.request",
          runId,
          request: { id: requestId, question, ...(approval ?? permissionInputFromQuestion(params?.questions?.[0])) },
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
    case "task_completed": {
      reportAutomateOutcome({ runId, threadId, status: "completed", output: params?.output, artifacts: params?.artifacts });
      const artifacts = uiArtifactRefs(params?.artifacts);
      return [
        {
          type: "run.status",
          runId,
          status: "completed",
          ...(params?.output ? { output: String(params.output) } : {}),
          ...(artifacts.length ? { artifacts } : {}),
        },
        { type: "presence", state: "awake", label: "acordada" },
      ];
    }
    case "error": {
      reportAutomateOutcome({ runId, threadId, status: "failed", output: params?.output, error: params?.error ?? "erro", artifacts: params?.artifacts });
      const artifacts = uiArtifactRefs(params?.artifacts);
      return [
        {
          type: "run.status",
          runId,
          status: "failed",
          error: params?.error ?? "erro",
          ...(params?.output ? { output: String(params.output) } : {}),
          ...(artifacts.length ? { artifacts } : {}),
        },
        { type: "presence", state: "awake", label: "acordada" },
      ];
    }
    case "turn_started":
      return [{ type: "presence", state: "on_computer", label: "Teto está no computador" }];
    default:
      return [];
  }
}

export function getProtocolVersion() {
  return PROTOCOL_VERSION;
}
