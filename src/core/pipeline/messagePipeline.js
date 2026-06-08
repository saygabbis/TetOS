import { detectTone } from "../memory/toneDetector.js";
import { extractFacts, extractStyle, isMeaningful, isMessyLaughterMessage, maxConsecutiveKRun } from "../memory/extractor.js";
import { detectDocumentIntent } from "../../modules/documents/documentIntent.js";
import { buildDocumentContextPayload } from "../../modules/documents/documentContextBuilder.js";
import { detectReminderIntent } from "../../modules/reminders/reminderIntent.js";
import { detectOperationIntent } from "../operations/operationIntent.js";
import { detectNaturalAdminIntent } from "../operations/naturalLanguageRouter.js";
import { detectConfirmationReply } from "../operations/confirmationIntent.js";
import { buildMediaContext } from "../media/mediaContext.js";
import { describeMediaForPrompt } from "../media/mediaHeuristics.js";
import { buildMultimodalContext } from "../memory/multimodalRetrieval.js";
import { ChatService } from "../../modules/chat/chatService.js";
import { detectVulnerability } from "../brain/vulnerabilityDetect.js";
import { touchUserActivity } from "../channels/userActivity.js";

function clampString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : value;
}

function normalizeHistory(messages, safeUserId, safeSessionId, maxHistory, maxContentLength) {
  const allowedRoles = new Set(["user", "assistant", "system"]);
  if (!Array.isArray(messages)) return null;
  return messages
    .filter((msg) => typeof msg?.content === "string")
    .map((msg) => ({ ...msg, content: msg.content.trim() }))
    .filter((msg) => msg.content)
    .slice(-Math.max(5, maxHistory))
    .map((msg) => ({
      role: allowedRoles.has(msg?.role) ? msg.role : "user",
      content: clampString(msg.content, maxContentLength),
      meta: { userId: safeUserId, sessionId: safeSessionId }
    }));
}

function buildStyleHint(input, tone, existingProfile, normalizedHistory, runtime, safeSessionId) {
  const style = extractStyle(input);
  const repeatedChars = (input.match(/([aeiou])\1{1,}/gi) ?? []).length;
  const burstMessages = input.split("\n").filter(Boolean).length;
  const userKkMaxRun = maxConsecutiveKRun(input);
  const compact = String(input).replace(/\s/g, "");
  const userKeyboardSmash =
    compact.length >= 10 &&
    /^[a-z]+$/i.test(compact) &&
    /[bcdfghjklmnpqrstvwxz]{6,}/i.test(compact);
  const userMessageMessy =
    repeatedChars >= 2 ||
    /(.)\1{2,}/i.test(input) ||
    userKkMaxRun >= 6 ||
    userKeyboardSmash ||
    isMessyLaughterMessage(input) ||
    /[^\w\s\u00C0-\u024F]{2,}/.test(input);

  const sessionKeyForSpam = safeSessionId ?? normalizedHistory?.[0]?.meta?.sessionId ?? "default";
  const priorUserTurns = (runtime.shortTerm.getAll(sessionKeyForSpam) ?? [])
    .filter((m) => m?.role === "user")
    .slice(-5)
    .map((m) => String(m?.content ?? "").trim());
  const recentUserTurns = [...priorUserTurns, String(input).trim()].slice(-6);
  const sparseGreetingOnly = (txt) => {
    const c = String(txt ?? "").trim().toLowerCase();
    return c.length > 0 && c.length < 22 && /^(oi+|oie+|oxi+|oxee+|eae+|ola+|hey+)[!.?…\s]*$/i.test(c);
  };
  const sparseGreetingFloodCount = recentUserTurns.filter(sparseGreetingOnly).length;

  let userLaughterEnergy = "low";
  if (userKkMaxRun >= 12 || userKeyboardSmash) userLaughterEnergy = "high";
  else if (userKkMaxRun >= 5 || /(?:ha|rs){3,}/i.test(input) || isMessyLaughterMessage(input)) {
    userLaughterEnergy = "medium";
  }

  const normalized = String(input ?? "").trim();
  const hasCaps = /[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{3,}/.test(normalized);
  const shortClauseCount = normalized.split(/[.!?]/).filter((s) => s.trim().length > 0).length;

  return {
    ...(existingProfile?.style ?? {}),
    userIsShort: style.isShort,
    userIsLong: style.isLong,
    repeatedVowels: repeatedChars,
    userGreetingIntensity: /^(oi+|oie+|eae+|hey+)/i.test(normalized) ? repeatedChars : 0,
    userBurst: burstMessages > 1,
    userKkMaxRun,
    userLaughterEnergy,
    userKeyboardSmash,
    userMessageMessy,
    userMessyLaughter: isMessyLaughterMessage(input),
    sparseGreetingFloodCount,
    userCapsBurst: hasCaps,
    userShortClauseCount: shortClauseCount,
    conversationEnergy: tone === "calm" ? "low" : "playful"
  };
}

export async function runMessagePipeline(runtime, payload = {}) {
  const {
    message,
    messages,
    userId,
    sessionId,
    channelId,
    isGroup = false,
    participants = [],
    isDirectMention = false,
    isReply = false,
    quotedMessage = null,
    messageKey = null,
    media = null,
    closeDecision = null
  } = payload;
  const effectiveCloseDecision = closeDecision ?? null;
  const safeUserId = typeof userId === "string" ? userId.slice(0, runtime.defaults.maxIdLength) : userId;
  const safeSessionId = typeof sessionId === "string" ? sessionId.slice(0, runtime.defaults.maxIdLength) : sessionId;
  const safeChannelId = typeof channelId === "string" && channelId.trim()
    ? channelId.slice(0, runtime.defaults.maxIdLength * 3)
    : (isGroup ? `group:${safeSessionId ?? safeUserId ?? "default"}` : `direct:${safeUserId ?? "default"}`);
  const channelScope = isGroup ? `group:${safeChannelId.replace(/^group:/, "")}` : "direct";

  let normalizedHistory = normalizeHistory(
    messages,
    safeUserId,
    safeSessionId,
    runtime.defaults.maxHistory,
    runtime.defaults.maxContentLength
  );

  if (!normalizedHistory?.length && runtime.shortTerm?.getAll) {
    const fromShort = runtime.shortTerm.getAll(safeSessionId ?? "default");
    if (fromShort.length) {
      normalizedHistory = fromShort.map((msg) => ({
        role: msg.role,
        content: msg.content,
        meta: { userId: safeUserId, sessionId: safeSessionId }
      }));
    }
  }

  const recentHistoryLimit = normalizedHistory?.length ? Math.max(3, Math.min(5, normalizedHistory.length)) : 0;
  const recentHistory = normalizedHistory?.length ? normalizedHistory.slice(-recentHistoryLimit) : null;
  const derivedMediaInput = media?.transcript ?? media?.caption ?? `[${media?.type ?? "media"}]`;
  const input = clampString(message ?? normalizedHistory?.[normalizedHistory.length - 1]?.content ?? derivedMediaInput, runtime.defaults.maxContentLength);

  if (!input) {
    const error = new Error("message is required");
    error.statusCode = 400;
    throw error;
  }

  const tone = detectTone(input);
  const existingProfile = runtime.longTerm.getProfile(safeUserId ?? "default", channelScope);
  const resumedAfterClose = Boolean(existingProfile?.conversationClosedAt);
  const styleHint = buildStyleHint(input, tone, existingProfile, normalizedHistory, runtime, safeSessionId);
  const groupMention = ChatService.extractGroupMention(input);
  const isVulnerable = detectVulnerability(input);
  const isDirectQuestion = ChatService.isLikelyQuestion(input);
  const effectiveMention = isDirectMention || Boolean(groupMention);

  let brainTurn = null;
  if (runtime.brainOrchestrator?.tickTurn) {
    brainTurn = await runtime.brainOrchestrator.tickTurn({
      message: input,
      userId: safeUserId,
      sessionId: safeSessionId,
      channelId: safeChannelId,
      channelScope: isGroup ? `group:${safeChannelId}` : "direct",
      isGroup,
      isDirectMention: effectiveMention,
      isReply,
      isDirectQuestion,
      tone,
      media,
      isVulnerable,
      closeDecision: effectiveCloseDecision
    });
  }

  const timingPlan = brainTurn?.timingPlan ?? null;

  const channelState = runtime.channelRegistry.applyMessageContext({
    channelId: safeChannelId,
    userId: safeUserId ?? "default",
    isGroup,
    participants
  });
  const policy = runtime.channelRegistry.shouldRespond({
    channelId: safeChannelId,
    userId: safeUserId ?? "default",
    isDirectMention: effectiveMention,
    isReply,
    isQuestion: isDirectQuestion
  });

  runtime.logger?.log?.("pipeline.policy", {
    userId: safeUserId ?? "default",
    sessionId: safeSessionId ?? "default",
    channelId: safeChannelId,
    policy
  });
  runtime.metrics?.increment?.("pipeline.policy.checked");

  if (!policy.allowed) {
    runtime.metrics?.increment?.("pipeline.policy.blocked");
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy
    };
  }

  const trimmedInput = String(input ?? "").trim();
  const directSubstantive =
    !isGroup &&
    (trimmedInput.length > 12 ||
      /[?]/.test(trimmedInput) ||
      /\b(fala|conta|me diz|o que|como|por que|pq)\b/i.test(trimmedInput));

  // timing_silence só corta resposta em grupo sem menção; no privado sempre gera reply.
  const timingSilenceSkip =
    isGroup &&
    timingPlan?.silenceAppropriate &&
    !effectiveMention &&
    !isReply &&
    effectiveCloseDecision !== "respond" &&
    !directSubstantive;

  if (timingSilenceSkip) {
    runtime.metrics?.increment?.("pipeline.timing.silence");
    runtime.logger?.log?.("pipeline.timing_silence", {
      userId: safeUserId,
      sessionId: safeSessionId,
      reasons: timingPlan.reasons ?? []
    });
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy: { ...policy, mode: "timing_silence" },
      timingPlan
    };
  }

  // #region agent log
  if (!isGroup && timingPlan?.silenceAppropriate) {
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "9518ce" },
      body: JSON.stringify({
        sessionId: "9518ce",
        location: "messagePipeline.js:dm_timing_bypass",
        message: "dm_bypassed_timing_silence",
        data: {
          userId: safeUserId,
          inputLen: trimmedInput.length,
          reasons: timingPlan.reasons ?? []
        },
        timestamp: Date.now(),
        hypothesisId: "H1",
        runId: "post-fix"
      })
    }).catch(() => {});
  }
  // #endregion

  if (!runtime.defaults.replyEnabled) {
    runtime.logger?.log?.("pipeline.observe_only", {
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId
    });
    runtime.metrics?.increment?.("pipeline.observe_only");
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy: { ...policy, mode: "learn_only" }
    };
  }

  const searchResult = await runtime.searchModule?.handle?.(input);
  if (searchResult?.results?.length) {
    runtime.metrics?.increment?.("search.executed");
  }
  const searchMeta = searchResult?.results?.length
    ? {
        searchQuery: searchResult.query,
        searchResults: searchResult.results
          .map((item, index) => `${index + 1}. ${item.title} — ${item.url}`)
          .join("\n")
      }
    : {};

  const confirmationReply = detectConfirmationReply(input);
  let confirmationResult = null;
  if (confirmationReply !== null) {
    const pending = runtime.pendingConfirmations?.findLatest?.(safeUserId ?? "default");
    if (pending) {
      if (confirmationReply === true) {
        confirmationResult = runtime.operationRouter.execute({
          type: pending.type,
          userId: safeUserId ?? "default",
          payload: { ...(pending.payload ?? {}), confirmed: true }
        });
      } else {
        confirmationResult = { cancelled: true, message: "Operação cancelada." };
      }
      runtime.pendingConfirmations?.resolve?.(safeUserId ?? "default");
    }
  }

  const slashCommandResult = runtime.chatCommandRouter?.execute?.({
    text: input,
    userId: safeUserId ?? "default"
  });

  const documentIntent = runtime.documentModule?.canHandle?.(input)
    ? detectDocumentIntent(input)
    : null;
  if (documentIntent) {
    runtime.metrics?.increment?.(`documents.intent.${documentIntent.type}`);
  }
  const documentPayload = buildDocumentContextPayload(documentIntent, runtime.documentModule);
  const documentContext = documentPayload?.text ?? null;

  const reminderIntent = detectReminderIntent(input);
  let reminderContext = null;
  if (reminderIntent?.type === "create") {
    const reminder = runtime.reminders.create({
      userId: safeUserId ?? "default",
      text: reminderIntent.text,
      dueAt: reminderIntent.dueAt ?? null
    });
    reminderContext = `Lembrete criado: ${reminder.text} (id ${reminder.id})${reminder.dueAt ? ` para ${reminder.dueAt}` : ""}`;
    runtime.metrics?.increment?.("reminders.created");
  } else if (reminderIntent?.type === "list") {
    const reminders = runtime.reminders.list(safeUserId ?? "default");
    reminderContext = reminders.length
      ? reminders.map((item) => `- ${item.id}: ${item.text}${item.done ? " [done]" : ""}`).join("\n")
      : "Nenhum lembrete encontrado.";
  } else if (reminderIntent?.type === "done") {
    const done = runtime.reminders.markDone(reminderIntent.id);
    reminderContext = done ? `Lembrete concluído: ${done.text}` : "Não achei esse lembrete.";
    if (done) runtime.metrics?.increment?.("reminders.completed");
  }

  const operationIntent = detectOperationIntent(input, safeChannelId) ?? detectNaturalAdminIntent(input, safeChannelId);
  if (operationIntent) {
    runtime.metrics?.increment?.("operations.intent.detected");
  }
  const operationResult = operationIntent
    ? runtime.operationRouter.execute({
        type: operationIntent.type,
        userId: safeUserId ?? "default",
        payload: operationIntent.payload
      })
    : null;

  if (operationIntent?.type === "channel_admin" && ["mute", "block"].includes(operationIntent?.payload?.action)) {
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy
    };
  }

  const historicalMultimodalContext = buildMultimodalContext(
    runtime.multimodalMemory?.list?.(safeUserId ?? "default") ?? [],
    3
  );
  const mediaContext = [
    describeMediaForPrompt(media, input) ?? buildMediaContext(media),
    historicalMultimodalContext ? `[RECENT MULTIMODAL MEMORY]\n${historicalMultimodalContext}` : null
  ].filter(Boolean).join("\n\n") || null;

  const primaryOperation = confirmationResult ?? slashCommandResult ?? operationResult;

  const operationMeta = primaryOperation && !primaryOperation.error
    ? {
        operationContext: JSON.stringify(primaryOperation)
      }
    : primaryOperation?.error
      ? {
          operationContext: `Erro operacional: ${primaryOperation.error}`
        }
      : {};

  if (media) {
    runtime.multimodalMemory?.save?.({
      userId: safeUserId ?? "default",
      channelId: safeChannelId,
      media,
      message: input
    });
    runtime.metrics?.increment?.("multimodal.saved");
  }

  const replies = await runtime.chatService.handleMessage(
    input,
    {
      userId: safeUserId,
      sessionId: safeSessionId,
      channelId: safeChannelId,
      quotedMessage,
      messageKey,
      styleHint,
      recentHistoryCount: normalizedHistory?.length ?? 0,
      recentHistory,
      resumedAfterClose,
      userPronouns: existingProfile?.facts?.pronouns ?? null,
      channelMode: channelState.mode,
      documentContext,
      reminderContext,
      mediaContext,
      closeDecision: effectiveCloseDecision,
      brainBlocks: brainTurn?.blocks ?? null,
      brainSnapshot: brainTurn?.snapshot ?? null,
      timingPlan: brainTurn?.timingPlan ?? null,
      brainOrchestratorEnabled: Boolean(runtime.brainOrchestrator?.enabled),
      isGroup,
      ...searchMeta,
      ...operationMeta
    },
    normalizedHistory,
    tone
  );

  if (runtime.brainOrchestrator?.logTurn) {
    runtime.brainOrchestrator.logTurn({
      turnId: `${safeSessionId}-${Date.now()}`,
      input: { message: input, channelId: safeChannelId, isGroup, media },
      brain: brainTurn?.snapshot ?? {},
      timingPlan,
      output: { replies, count: replies.length }
    });
  }

  if (replies.length > 0 && runtime.brainOrchestrator?.memory?.recordEpisode) {
    runtime.brainOrchestrator.memory.recordEpisode({
      userId: safeUserId ?? "default",
      channelId: safeChannelId,
      channelScope: isGroup ? `group:${safeChannelId}` : "direct",
      summary: input.slice(0, 280),
      userMessage: input,
      assistantReplies: replies,
      tone,
      ts: new Date().toISOString()
    });
    for (const reply of replies) {
      runtime.brainOrchestrator.recordAssistantOutput?.(safeSessionId, reply, {
        userId: safeUserId,
        channelId: safeChannelId
      });
    }
  }

  if (isGroup && runtime.groupMemory?.append && replies.length > 0) {
    for (const reply of replies) {
      runtime.groupMemory.append({
        channelId: safeChannelId,
        userId: "teto",
        text: reply,
        addressedToTeto: true,
        ts: new Date().toISOString()
      });
    }
  }

  touchUserActivity(runtime, safeUserId ?? "default");

  if (replies.length > 0 && resumedAfterClose) {
    runtime.longTerm.updateProfile(safeUserId ?? "default", { conversationClosedAt: null }, channelScope);
  }

  const facts = replies.length > 0 ? extractFacts(input) : [];
  if (replies.length > 0) {
    for (const fact of facts) {
      runtime.longTerm.save({
        tags: [fact.type],
        type: fact.type,
        value: fact.value,
        userId: safeUserId ?? "default",
        channelId: safeChannelId,
        channelScope
      });
    }

    const style = extractStyle(input);
    const profile = existingProfile;
    const counts = profile.counts ?? {};
    const nextCounts = {
      abbrev: (counts.abbrev ?? 0) + (style.usesAbbrev ? 1 : 0),
      laughter: (counts.laughter ?? 0) + (style.usesLaughter ? 1 : 0),
      emoji: (counts.emoji ?? 0) + (style.usesEmojis ? 1 : 0)
    };
    const total = Math.max(1, (counts.total ?? 0) + 1);
    const nextStyle = {
      prefersAbbrev: nextCounts.abbrev / total > 0.4,
      prefersLaughter: nextCounts.laughter / total > 0.4,
      prefersEmoji: nextCounts.emoji / total > 0.3,
      brevity: style.isShort ? "short" : style.isLong ? "long" : "medium"
    };

    runtime.longTerm.updateProfile(safeUserId ?? "default", {
      facts: {
        ...(facts.find((f) => f.type === "user_name") ? { name: facts.find((f) => f.type === "user_name").value } : {}),
        ...(facts.find((f) => f.type === "user_pronouns") ? { pronouns: facts.find((f) => f.type === "user_pronouns").value } : {}),
        lastChannel: isGroup ? "group" : "direct"
      },
      style: nextStyle,
      counts: { ...nextCounts, total }
    }, channelScope);
  }

  if (replies.length > 0 && isMeaningful(input)) {
    runtime.longTerm.addMediumTerm(safeUserId ?? "default", {
      summary: input,
      timestamp: new Date().toISOString(),
      channelId: safeChannelId
    }, 20, channelScope);
    runtime.longTerm.pruneMediumTerm(safeUserId ?? "default", 20, channelScope);
  }

  const memoryCandidates = replies.length > 0
    ? runtime.selectiveMemory.buildCandidate(input, facts)
    : [];
  for (const candidate of memoryCandidates) {
    runtime.selectiveMemory.remember({
      userId: safeUserId ?? "default",
      channelId: safeChannelId,
      content: candidate,
      source: facts.length ? "fact" : "message"
    });
  }

  const promoted = runtime.selectiveMemory.pullPromotions({
    userId: safeUserId ?? "default",
    channelId: safeChannelId
  });
  for (const entry of promoted) {
    runtime.longTerm.save({
      userId: safeUserId ?? "default",
      channelId: safeChannelId,
      channelScope,
      tags: ["selective_memory"],
      type: "selective_memory",
      content: entry.content,
      value: entry.content
    });
  }

  runtime.logger?.log?.("pipeline.completed", {
    userId: safeUserId ?? "default",
    sessionId: safeSessionId ?? "default",
    channelId: safeChannelId,
    replyCount: replies.length,
    policyReason: policy?.reason ?? null,
    searched: Boolean(searchResult?.results?.length),
    hasDocumentContext: Boolean(documentContext),
    hasOperationContext: Boolean(operationMeta?.operationContext),
    hasMediaContext: Boolean(mediaContext)
  });
  runtime.metrics?.increment?.("pipeline.completed");
  if (replies.length > 0) {
    runtime.metrics?.increment?.("pipeline.replied");
  }

  return {
    replies,
    userId: safeUserId ?? "default",
    sessionId: safeSessionId ?? "default",
    channelId: safeChannelId,
    input,
    tone,
    policy,
    timingPlan
  };
}
