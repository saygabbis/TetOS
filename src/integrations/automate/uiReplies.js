import { bindRunToThread, markRunForExplanation, registerAutomateRun } from "./automateRunContext.js";
import { applyUiMediaAction, isUiMediaAction } from "../ui/uiMediaActions.js";
import { applyOrganizerAction } from "../automate-hub/hubOrganizer.js";

export function parseInstructionFromEnqueueResult(result) {
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
  uiBus.publish({ type: "presence", state: "awake", label: "acordada" });
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

const REACTION_WORDS = {
  joia: "👍",
  joinha: "👍",
  like: "👍",
  ok: "👍",
  amor: "❤️",
  coracao: "❤️",
  "coração": "❤️",
  heart: "❤️",
  risada: "😂",
  kkk: "😂",
};

/** Comando de reação (inclusive com typo, ex.: "regir(joia)") que vazou como texto da mensagem. */
const LOOSE_REACTION_RE = /\b(?:reagir|regir|reajir|react)\s*\(\s*["']?([^"')]*?)["']?\s*\)/gi;

function toReactionEmoji(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  return REACTION_WORDS[value.toLowerCase()] ?? (/[\p{Extended_Pictographic}]/u.test(value) ? value : null);
}

/** Tira comandos de reação do texto: a reação vira meta na mensagem, nunca texto no chat. */
function splitLooseReactions(text) {
  const emojis = [];
  const clean = String(text ?? "")
    .replace(LOOSE_REACTION_RE, (_all, arg) => {
      const emoji = toReactionEmoji(arg);
      if (emoji) emojis.push(emoji);
      return "";
    })
    .trim();
  return { text: clean, emojis };
}

/**
 * Aplica ações da Teto (mensagem, computador, etc.) no contexto da UI desktop.
 */
export async function applyUiOutgoingActions({
  replies,
  thread,
  uiBus,
  automateClient,
  assistantMessageId = null,
  mediaContext = null,
}) {
  const rawActions = Array.isArray(replies?.actions) ? replies.actions : [];
  const actions = [];
  for (const action of rawActions) {
    if (action?.type !== "message" || !action.text) {
      actions.push(action);
      continue;
    }
    const { text, emojis } = splitLooseReactions(action.text);
    for (const emoji of emojis) actions.push({ type: "react", emoji });
    if (text) actions.push({ ...action, text });
  }
  const fallbackTexts = [];
  if (!Array.isArray(replies?.actions) && Array.isArray(replies)) {
    for (const r of replies) {
      if (typeof r !== "string" || !r.trim()) continue;
      const { text, emojis } = splitLooseReactions(r);
      for (const emoji of emojis) actions.push({ type: "react", emoji });
      if (text) fallbackTexts.push(text);
    }
  }

  if (fallbackTexts.length > 0 && !actions.some((a) => a?.type === "message")) {
    if (mediaContext) {
      for (const action of actions) {
        if (action.type === "react") await applyUiMediaAction({ ...mediaContext, thread, uiBus }, action);
      }
    }
    const assistantMsg = {
      id: assistantMessageId ?? `a-${Date.now()}`,
      role: "assistant",
      text: fallbackTexts.join("\n"),
      createdAt: new Date().toISOString(),
    };
    thread.messages.push(assistantMsg);
    thread.updatedAt = new Date().toISOString();
    uiBus.publish({ type: "message.final", threadId: thread.id, message: assistantMsg });
    return;
  }

  let usedStreamMessageId = false;
  for (const action of actions) {
    if (action.type === "message" && action.text) {
      const msgId =
        assistantMessageId && !usedStreamMessageId
          ? assistantMessageId
          : `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      if (assistantMessageId && !usedStreamMessageId) usedStreamMessageId = true;
      const existingIdx = thread.messages.findIndex((m) => m.id === msgId);
      const assistantMsg = {
        id: msgId,
        role: "assistant",
        text: action.text,
        createdAt:
          existingIdx >= 0 ? thread.messages[existingIdx].createdAt : new Date().toISOString(),
      };
      if (existingIdx >= 0) {
        thread.messages[existingIdx] = { ...thread.messages[existingIdx], ...assistantMsg };
      } else {
        thread.messages.push(assistantMsg);
      }
      thread.updatedAt = new Date().toISOString();
      uiBus.publish({ type: "message.final", threadId: thread.id, message: assistantMsg });
      continue;
    }

    // Figurinhas, mídia, downloads, geração de imagem, repertório e reações: mesmas ações do WhatsApp.
    if (mediaContext && isUiMediaAction(action)) {
      await applyUiMediaAction({ ...mediaContext, thread, uiBus }, action);
      continue;
    }

    // Objetivos e agenda: o hub decide (aplica, guarda como proposta ou recusa) e o usuário lê o que de fato houve.
    if (action.type === "organizer") {
      const outcome = await applyOrganizerAction(action, { threadId: thread.id });
      const outcomeMsg = {
        id: `a-org-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        text: outcome.text,
        createdAt: new Date().toISOString(),
      };
      thread.messages.push(outcomeMsg);
      thread.updatedAt = new Date().toISOString();
      uiBus.publish({ type: "message.final", threadId: thread.id, message: outcomeMsg });
      continue;
    }

    if (action.type === "automate" && action.intent) {
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      bindRunToThread(runId, thread.id);
      // Quando terminar, a Teto explica o resultado na conversa (pedido dela ou do usuário via @automate).
      markRunForExplanation(runId, action.intent, { fromUser: Boolean(action.fromUser) });
      publishAutomateRunStarted(uiBus, { runId, threadId: thread.id });
      try {
        const result = await automateClient.enqueue(action.intent, undefined, {
          threadId: thread.id,
          runId,
          skillNames: Array.isArray(action.skillRefs) ? action.skillRefs : undefined,
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

  // A resposta virou só ação (figurinha, reação, execução no PC): o balão que recebeu o streaming fica sem dono.
  // Final vazia com o mesmo id = o app descarta o balão, em vez de mostrar o comando cru (ex.: sticker("teto-pao")).
  if (assistantMessageId && !usedStreamMessageId) {
    uiBus.publish({
      type: "message.final",
      threadId: thread.id,
      message: { id: assistantMessageId, role: "assistant", text: "", createdAt: new Date().toISOString() },
    });
  }
}
