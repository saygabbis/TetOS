import { ChatService } from "../../modules/chat/chatService.js";
import {
  countTrailingAssistantTurns,
  detectTopicClosed
} from "../autonomy/ghostingPolicy.js";
import { detectUserBoundary } from "../channels/userBoundaryDetect.js";
import { detectWrongBotNameVocative } from "../../integrations/whatsapp/tetoNameDetect.js";
import { contextualSeed, chance } from "./rng.js";

const STOPWORDS = new Set([
  "a", "o", "e", "de", "da", "do", "em", "no", "na", "que", "pra", "pro", "com", "um", "uma",
  "eu", "tu", "vc", "voce", "você", "ele", "ela", "isso", "aqui", "ali", "la", "lá", "ja", "já",
  "to", "tô", "ta", "tá", "ne", "né", "ai", "aí", "so", "só", "mas", "por", "se", "me", "te",
  "kkk", "kkkk", "kkkkk", "haha", "rs", "tipo", "bem", "muito", "mais", "menos", "agora", "hoje"
]);

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function overlapRatio(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((w) => setB.has(w)).length;
  return shared / Math.max(a.length, b.length);
}

function lastUserMessageInHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "user") return history[i];
  }
  return null;
}

function detectTopicShift(message = "", history = []) {
  const prev = lastUserMessageInHistory(history);
  if (!prev?.content) return { detected: false, hint: null, confidence: 0 };

  const currentTokens = tokenize(message);
  const prevTokens = tokenize(prev.content);
  if (currentTokens.length < 2) return { detected: false, hint: null, confidence: 0 };

  const overlap = overlapRatio(currentTokens, prevTokens);
  const substantive = String(message).trim().length > 18 || /\?/.test(message);
  const detected = overlap < 0.28 && substantive;
  const newWords = currentTokens.filter((w) => !prevTokens.includes(w)).slice(0, 4);

  return {
    detected,
    hint: detected && newWords.length ? newWords.join(", ") : null,
    confidence: detected ? Math.min(0.92, 0.55 + (0.28 - overlap) * 1.4) : 0
  };
}

function lastAssistantMessage(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "assistant") return history[i];
  }
  return null;
}

function assistantSentFarewell(content = "") {
  const t = normalize(content);
  return (
    /\b(vai la|vai lá|bora|flw|falou|tchau|descansa|dorme|bom jogo|boa partida|boa noite)\b/.test(t) ||
    ChatService.isConversationClosure(content) ||
    ChatService.isShortAcknowledgement(content)
  );
}

function userAnnouncedDeparture(text = "") {
  const t = normalize(text);
  return (
    detectTopicClosed(text) ||
    /\b(vou|to|tô)\s+(jogar|dormir|comer|sair|embora|trabalhar|estudar|descansar)\b/.test(t) ||
    /\b(bora|partida|ranked|partida)\b/.test(t)
  );
}

function pickLullAction(message, sessionId, trailingBot = 0, opts = {}) {
  const { assistantAlreadyFarewelled = false, userHardClose = false } = opts;
  const seed = contextualSeed(["lull", sessionId, normalize(message).slice(0, 40)]);

  if (assistantAlreadyFarewelled && !userHardClose) {
    if (ChatService.isEmojiOnlyMessage(message)) {
      if (chance(seed, 0.62)) return "react";
      return "silent";
    }
    if (chance(seed, 0.58)) return "silent";
    if (chance(seed + 1, 0.88)) return "react";
    return "silent";
  }

  if (ChatService.isEmojiOnlyMessage(message)) {
    if (chance(seed, 0.52)) return "react";
    if (chance(seed + 1, 0.78)) return "silent";
    if (chance(seed + 2, 0.9)) return "brief_farewell";
    return "react";
  }

  if (userHardClose) {
    if (chance(seed, 0.82)) return "silent";
    if (chance(seed + 1, 0.94)) return "react";
    return "brief_farewell";
  }

  if (trailingBot >= 2) {
    if (chance(seed, 0.48)) return "silent";
    if (chance(seed + 1, 0.72)) return "react";
    if (chance(seed + 2, 0.86)) return "brief_farewell";
    return "silent";
  }

  if (chance(seed, 0.3)) return "silent";
  if (chance(seed + 1, 0.55)) return "react";
  if (chance(seed + 2, 0.76)) return "brief_farewell";
  return "silent";
}

function lastWordFromAction(action, assistantAlreadyFarewelled) {
  if (action === "brief_farewell") return "teto_may";
  if (action === "silent" || action === "react") {
    return assistantAlreadyFarewelled ? "user_fine" : "either";
  }
  return "either";
}

function actionToCloseDecision(action) {
  if (action === "silent") return "silent";
  if (action === "react") return "react";
  if (action === "brief_farewell") return "brief_farewell";
  if (action === "brief_ack") return "brief_farewell";
  return "none";
}

/**
 * Analisa a fase conversacional consultando histórico, vínculo, repetição e heurísticas de encerramento.
 */
export function analyzeConversationPhase(ctx = {}) {
  const message = String(ctx.message ?? "").trim();
  const history = Array.isArray(ctx.history) ? ctx.history : [];
  const signals = [];
  let phase = "active";
  let confidence = 0.35;
  let recommendedAction = "respond";

  const isDirectTetoCall = ctx.isDirectTetoCall ?? ChatService.isDirectTetoCall(message);
  const isLull = ChatService.isConversationLull(message);
  const boundary = detectUserBoundary(message);
  const isHardClose =
    boundary.level === "hard" ||
    ChatService.isConversationClosure(message) ||
    detectTopicClosed(message);
  const isDirectQuestion = ctx.isDirectQuestion ?? ChatService.isLikelyQuestion(message);
  const trailingBot = countTrailingAssistantTurns(history);
  const lastAssistant = lastAssistantMessage(history);
  const lastWasQuestion = lastAssistant?.content && ChatService.isLikelyQuestion(lastAssistant.content);
  const topicShift = detectTopicShift(message, history);
  const prevUser = lastUserMessageInHistory(history);
  const userWasLeaving = prevUser?.content && userAnnouncedDeparture(prevUser.content);
  const assistantBlessed = lastAssistant?.content && assistantSentFarewell(lastAssistant.content);
  const wrongBotName = ctx.wrongBotName ?? detectWrongBotNameVocative(message);

  if (isHardClose) {
    phase = "hard_close";
    recommendedAction =
      wrongBotName && !isDirectQuestion
        ? "brief_farewell"
        : pickLullAction(message, ctx.sessionId ?? "default", trailingBot, {
            userHardClose: true,
            assistantAlreadyFarewelled: assistantBlessed
          });
    confidence = wrongBotName ? 0.9 : 0.82;
    signals.push("despedida_explicita");
    if (wrongBotName) signals.push(`nome_errado:${wrongBotName}`);
  } else if (ctx.isVulnerable) {
    signals.push("vulnerabilidade");
    return {
      phase: "active",
      recommendedAction: "respond",
      closeDecision: "none",
      confidence: 0.88,
      signals,
      topicShift,
      reasoning: "vulnerabilidade — não encerrar"
    };
  } else if (ctx.isDirectMention) {
    signals.push("chamada_direta");
    return {
      phase: "active",
      recommendedAction: "respond",
      closeDecision: "none",
      confidence: 0.88,
      signals,
      topicShift,
      reasoning: "chamada direta em grupo — não encerrar"
    };
  }

  if (isDirectTetoCall && boundary.level !== "hard") {
    signals.push("chamou_teto");
    return {
      phase: "active",
      recommendedAction: "respond",
      closeDecision: "none",
      confidence: 0.9,
      signals,
      topicShift,
      reasoning: "chamou a Teto pelo nome"
    };
  }

  if (ctx.resumedAfterClose && message.length > 6 && !isLull) {
    phase = "reopening";
    recommendedAction = "respond";
    confidence = 0.7;
    signals.push("pap_reaberto");
  } else if (topicShift.detected && topicShift.confidence >= 0.55 && !lastWasQuestion) {
    phase = "topic_shift";
    recommendedAction = "respond";
    confidence = topicShift.confidence;
    signals.push("mudanca_de_assunto");
  } else if (lastWasQuestion && !isLull && !isHardClose) {
    phase = "pending_answer";
    recommendedAction = "respond";
    confidence = 0.62;
    signals.push("pergunta_pendente_do_assistente");
  } else if (userWasLeaving && isLull && assistantBlessed) {
    phase = "winding_down";
    recommendedAction = pickLullAction(message, ctx.sessionId ?? "default", trailingBot, {
      assistantAlreadyFarewelled: true
    });
    confidence = 0.86;
    signals.push("usuario_ja_foi_assistente_ja_benzeu");
  } else if (isLull) {
    phase = trailingBot >= 1 ? "natural_end" : "lull";
    recommendedAction = pickLullAction(message, ctx.sessionId ?? "default", trailingBot, {
      assistantAlreadyFarewelled: assistantBlessed
    });
    confidence = trailingBot >= 2 ? 0.84 : trailingBot >= 1 ? 0.76 : 0.68;
    signals.push(trailingBot >= 1 ? "lull_pos_resposta_bot" : "lull_simples");
  } else if (trailingBot >= 2 && String(message).length < 8) {
    phase = "natural_end";
    recommendedAction = "silent";
    confidence = 0.72;
    signals.push("msg_curta_pos_varias_do_bot");
  }

  const overused = ctx.repetition?.overusedTopics ?? [];
  if (overused.length && (phase === "lull" || phase === "natural_end" || phase === "winding_down")) {
    signals.push("temas_repetidos_no_historico");
    confidence = Math.min(0.95, confidence + 0.08);
    if (recommendedAction === "respond" || recommendedAction === "brief_ack") {
      recommendedAction = "silent";
    }
  }

  const bond = ctx.trustBond;
  if (bond?.intimacy > 0.75 && phase === "lull" && recommendedAction === "silent") {
    if (chance(contextualSeed(["bond", ctx.sessionId ?? "default"]), 0.35)) {
      recommendedAction = "react";
      signals.push("intimidade_alta_react_em_vez_de_silent");
    }
  }

  if (phase === "pending_answer" && isLull && ChatService.isPositiveWellbeingReply(message)) {
    phase = "natural_end";
    recommendedAction = pickLullAction(message, ctx.sessionId ?? "default", trailingBot, {
      assistantAlreadyFarewelled: assistantBlessed
    });
    confidence = 0.8;
    signals.push("lull_como_resposta_a_tudo_bem");
  }

  const closeDecision = actionToCloseDecision(recommendedAction);
  const lastWord = lastWordFromAction(recommendedAction, assistantBlessed);
  const reasoning = buildPhaseReasoning(phase, signals, topicShift, lastWord);

  return {
    phase,
    recommendedAction,
    closeDecision,
    lastWord,
    confidence,
    signals,
    topicShift,
    reasoning,
    trailingBot,
    closeDecisionHint: ctx.closeDecisionHint ?? null
  };
}

function buildPhaseReasoning(phase, signals, topicShift, lastWord) {
  const parts = [`fase: ${phase}`];
  if (lastWord && lastWord !== "either") parts.push(`ultima_palavra: ${lastWord}`);
  if (signals.length) parts.push(`sinais: ${signals.join(", ")}`);
  if (topicShift?.detected && topicShift.hint) parts.push(`novo assunto: ${topicShift.hint}`);
  return parts.join(" | ");
}

/**
 * Resolve closeDecision final combinando heurística rápida (ChatService) com análise do cérebro.
 */
export function resolveCloseDecision(ctx = {}) {
  const analysis = analyzeConversationPhase(ctx);
  const heuristic = ctx.heuristicDecision ?? ctx.closeDecisionHint ?? null;

  if (analysis.phase === "active" || analysis.phase === "topic_shift" || analysis.phase === "reopening") {
    if (analysis.phase === "topic_shift" && analysis.confidence >= 0.55) {
      return { closeDecision: "none", analysis };
    }
    if (heuristic && heuristic !== "none") {
      return { closeDecision: heuristic, analysis };
    }
    return { closeDecision: "none", analysis };
  }

  if (analysis.phase === "pending_answer" && analysis.recommendedAction === "respond") {
    return { closeDecision: "none", analysis };
  }

  if (analysis.confidence >= 0.65) {
    return { closeDecision: analysis.closeDecision, analysis };
  }

  if (heuristic && heuristic !== "none") {
    return { closeDecision: heuristic, analysis };
  }

  return { closeDecision: analysis.closeDecision, analysis };
}

/** Refina closeDecision depois do tickTurn quando o cérebro tem mais contexto. */
export function mergeBrainCloseDecision(existing, phaseAnalysis) {
  if (!phaseAnalysis) return existing ?? null;
  const current = existing ?? "none";

  if (phaseAnalysis.recommendedAction === "brief_farewell" && phaseAnalysis.confidence >= 0.58) {
    return "brief_farewell";
  }

  if (phaseAnalysis.phase === "topic_shift" || phaseAnalysis.phase === "reopening") {
    if (current === "silent" || current === "react") return "none";
    return current;
  }

  if (phaseAnalysis.confidence >= 0.72) {
    return phaseAnalysis.closeDecision;
  }

  if (phaseAnalysis.confidence >= 0.58 && (current === "none" || current === "open" || !current)) {
    return phaseAnalysis.closeDecision;
  }

  return current === "open" ? "none" : current;
}

export function formatConversationPhaseBlock(phaseAnalysis) {
  if (!phaseAnalysis?.phase) return [];

  const lines = [
    "[CONVERSATION PHASE — cérebro]",
    `fase: ${phaseAnalysis.phase}`,
    `confiança: ${(phaseAnalysis.confidence ?? 0).toFixed(2)}`,
    `ação recomendada: ${phaseAnalysis.recommendedAction ?? "respond"}`
  ];

  if (phaseAnalysis.reasoning) lines.push(phaseAnalysis.reasoning);
  if (phaseAnalysis.lastWord === "teto_may") {
    lines.push("ultima palavra: pode ser sua — despedida curtíssima ok");
  } else if (phaseAnalysis.lastWord === "user_fine") {
    lines.push("ultima palavra: a pessoa já fechou — silêncio ou reação leve");
  }
  if (phaseAnalysis.topicShift?.detected) {
    lines.push(`mudança de assunto detectada${phaseAnalysis.topicShift.hint ? `: ${phaseAnalysis.topicShift.hint}` : ""}`);
  }

  const wrongNameSignal = (phaseAnalysis.signals ?? []).find((s) => String(s).startsWith("nome_errado:"));
  if (wrongNameSignal) {
    lines.push(
      "Erraram seu nome na despedida — correção leve numa frase (tipo 'é Teto kkk') e fecha.",
      "Sem bronca, sem palestra, sem 'volta quando quiser' extra."
    );
  }

  if (phaseAnalysis.recommendedAction === "brief_farewell" || phaseAnalysis.closeDecision === "brief_farewell") {
    lines.push(
      "Você PODE mandar 1 despedida bem curta (flw, boa noite, vai lá, se cuida, bons sonhos) se quiser a última palavra.",
      "1 bolha só — sem pergunta, sem café, sem esticar.",
      "Proibido pedir ligação/telefone — só zap por texto.",
      "Se achar que a pessoa já fechou bonito e não precisa: [SEM_RESPOSTA] também vale."
    );
  } else if (["lull", "natural_end", "winding_down", "hard_close"].includes(phaseAnalysis.phase)) {
    lines.push(
      "Papo encerrando — silêncio, reação leve ou despedida curtíssima: escolha o que fizer sentido.",
      "Não tem regra de quem fala por último; você ou a pessoa podem fechar.",
      "Se não couber nada: [SEM_RESPOSTA]. Se quiser última palavra: 1 linha de despedida, nada além."
    );
  }

  if (phaseAnalysis.phase === "topic_shift") {
    lines.push("Assunto novo — responda ao que veio agora, não retome o tópico antigo por inércia.");
  }

  if (phaseAnalysis.phase === "pending_answer") {
    lines.push("Você fez pergunta recente — trate a msg como resposta ou continuação, não como fim de papo.");
  }

  return lines;
}
