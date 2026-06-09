import { detectTone } from "../memory/toneDetector.js";
import { extractFacts, extractStyle, isMeaningful, isMessyLaughterMessage, maxConsecutiveKRun } from "../memory/extractor.js";
import { analyzeInformalTyping } from "../memory/informalTyping.js";
import { formatLearnedStyleForPrompt, updateLearnedStyle } from "../memory/userStyleLearner.js";
import { detectDocumentIntent } from "../../modules/documents/documentIntent.js";
import { buildDocumentContextPayload } from "../../modules/documents/documentContextBuilder.js";
import { detectReminderIntent } from "../../modules/reminders/reminderIntent.js";
import { detectOperationIntent } from "../operations/operationIntent.js";
import { detectNaturalAdminIntent } from "../operations/naturalLanguageRouter.js";
import { detectConfirmationReply } from "../operations/confirmationIntent.js";
import { buildMediaContext } from "../media/mediaContext.js";
import { describeMediaForPrompt } from "../media/mediaHeuristics.js";
import { buildMultimodalContext } from "../memory/multimodalRetrieval.js";
import { detectTetoInMediaDescription } from "../character/tetoSelfRecognition.js";
import { hasVocativeToTeto } from "../../modules/chat/coherenceGuards.js";
import { ChatService } from "../../modules/chat/chatService.js";
import { detectVulnerability } from "../brain/vulnerabilityDetect.js";
import { mergeBrainCloseDecision } from "../brain/ConversationPhaseEngine.js";
import { isOwnerContact, touchUserActivity } from "../channels/userActivity.js";
import { buildGroupRoster } from "../channels/groupRoster.js";
import {
  addProfileNicknames,
  captureTetoNicknamesFromReplies
} from "../channels/waIdentity.js";

function clampString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : value;
}

function mentionsMachineLove(text = "") {
  const t = String(text ?? "");
  return (
    /\b(machine\s*love|m[aá]quina\s+love)\b/i.test(t) ||
    /\b(me\s+ensina\s+a\s+ser\s+real|peito\s+digital|bin[aá]rio\s+o\s+meu\s+coral)\b/i.test(t) ||
    /\b(jamie\s+paige|revela[cç][aã]o\s+final)\b/i.test(t) ||
    /canta\s+o\s+peito/i.test(t) ||
    /v[aã]o\s+te\s+adorar/i.test(t)
  );
}

function normalizeHistory(messages, safeUserId, safeSessionId, maxHistory, maxContentLength) {
  const allowedRoles = new Set(["user", "assistant", "system"]);
  if (!Array.isArray(messages)) return null;
  const cap = Math.max(8, Number(maxHistory) || 24);
  return messages
    .filter((msg) => typeof msg?.content === "string")
    .map((msg) => ({ ...msg, content: msg.content.trim() }))
    .filter((msg) => msg.content)
    .slice(-cap)
    .map((msg) => ({
      role: allowedRoles.has(msg?.role) ? msg.role : "user",
      content: clampString(msg.content, maxContentLength),
      meta: { userId: safeUserId, sessionId: safeSessionId, ...(msg.meta ?? {}) }
    }));
}

export function groupChannelSessionId(channelId) {
  return `wa-group-channel:${String(channelId ?? "").trim()}`;
}

function buildGroupTranscript(runtime, channelId, limit = 16) {
  const entries = runtime.groupMemory?.byChannel?.(channelId, { limit }) ?? [];
  return entries
    .slice()
    .reverse()
    .map((entry) => {
      const who = entry.speakerName || entry.userId || "alguém";
      const tag = entry.addressedToTeto ? "" : " (off-topic)";
      return {
        role: "user",
        content: `[${who}]${tag}: ${String(entry.text ?? "").trim()}`,
        meta: { groupTranscript: true, userId: entry.userId }
      };
    })
    .filter((m) => m.content.length > 4);
}

function shortTermToHistory(rows, safeUserId, safeSessionId, maxHistory, maxContentLength) {
  if (!rows?.length) return null;
  return normalizeHistory(
    rows.map((msg) => ({
      role: msg.role,
      content: msg.content,
      meta: msg.meta ?? {}
    })),
    safeUserId,
    safeSessionId,
    maxHistory,
    maxContentLength
  );
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

  const vocativeToTeto = hasVocativeToTeto(input);
  const hasPriorTurns = priorUserTurns.length > 0;
  const learned = existingProfile?.style?.learned ?? {};
  const stylePrefs = existingProfile?.style ?? {};
  const preferredLaughter =
    userKkMaxRun >= 3 ? "kk" : learned.preferredLaughter ?? (stylePrefs.prefersLaughter ? "kk" : null);
  const learnedStyleLines = formatLearnedStyleForPrompt(learned, stylePrefs, {
    userKkMaxRun,
    preferredLaughter
  });
  const informal = analyzeInformalTyping(input);

  return {
    ...stylePrefs,
    userVocativeToTeto: vocativeToTeto,
    hasConversationHistory: hasPriorTurns,
    userIsShort: style.isShort,
    userIsLong: style.isLong,
    repeatedVowels: Math.max(repeatedChars, informal.stretchedVowels),
    userGreetingIntensity: /^(oi+|oie+|eae+|hey+)/i.test(normalized) ? Math.max(repeatedChars, informal.stretchedVowels) : 0,
    userBurst: burstMessages > 1,
    userKkMaxRun,
    userLaughterEnergy,
    userKeyboardSmash: userKeyboardSmash || informal.keyboardSmash,
    userMessageMessy: userMessageMessy || informal.melty,
    userMessyLaughter: isMessyLaughterMessage(input) || informal.keyboardSmash,
    userMeltyTyping: informal.melty,
    userAffectionateBurst: informal.affectionate,
    userLowPunctuation: informal.lowPunctuation,
    userSkipTypoCorrection: informal.skipTypoCorrection,
    userCanMirrorLoose: informal.canMirrorLoose,
    sparseGreetingFloodCount,
    userCapsBurst: hasCaps,
    userShortClauseCount: shortClauseCount,
    conversationEnergy: tone === "calm" ? "low" : "playful",
    preferredLaughter,
    learnedStyleLines,
    learnedExpressions: Object.keys(learned.expressions ?? {}).slice(0, 10)
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
    groupEngagementActive = false,
    groupAddressKind = null,
    isReply = false,
    quotedMessage = null,
    quotedMessageId = null,
    replyThreadContext = null,
    isReplyToBot = false,
    messageKey = null,
    media = null,
    closeDecision = null,
    pushName = null,
    participantId = null,
    segmentSpeakers = null,
    segmentMultiSpeaker = false,
    isOwner: isOwnerFlag = null
  } = payload;
  const effectiveCloseDecision = closeDecision ?? null;
  const safeUserId = typeof userId === "string" ? userId.slice(0, runtime.defaults.maxIdLength) : userId;
  const safeSessionId = typeof sessionId === "string" ? sessionId.slice(0, runtime.defaults.maxIdLength) : sessionId;
  const safeChannelId = typeof channelId === "string" && channelId.trim()
    ? channelId.slice(0, runtime.defaults.maxIdLength * 3)
    : (isGroup ? `group:${safeSessionId ?? safeUserId ?? "default"}` : `direct:${safeUserId ?? "default"}`);
  const channelScope = isGroup ? `group:${safeChannelId.replace(/^group:/, "")}` : "direct";
  const isOwner =
    isOwnerFlag === true ||
    (isOwnerFlag !== false && isOwnerContact(runtime, safeChannelId, safeUserId));

  let normalizedHistory = normalizeHistory(
    messages,
    safeUserId,
    safeSessionId,
    runtime.defaults.maxHistory,
    runtime.defaults.maxContentLength
  );

  if (!normalizedHistory?.length && runtime.shortTerm?.getAll) {
    const fromUser = runtime.shortTerm.getAll(safeSessionId ?? "default") ?? [];
    const fromGroupChannel =
      isGroup && safeChannelId
        ? runtime.shortTerm.getAll(groupChannelSessionId(safeChannelId)) ?? []
        : [];
    if (isGroup && fromGroupChannel.length) {
      normalizedHistory = shortTermToHistory(
        fromGroupChannel,
        safeUserId,
        safeSessionId,
        runtime.defaults.maxHistory,
        runtime.defaults.maxContentLength
      );
    } else if (fromUser.length) {
      normalizedHistory = shortTermToHistory(
        fromUser,
        safeUserId,
        safeSessionId,
        runtime.defaults.maxHistory,
        runtime.defaults.maxContentLength
      );
    } else if (isGroup && safeChannelId) {
      normalizedHistory = buildGroupTranscript(runtime, safeChannelId, 14);
    }
  }

  const historyCap = Math.max(8, Number(runtime.defaults.maxHistory) || 24);
  const recentHistory = normalizedHistory?.length ? normalizedHistory.slice(-historyCap) : null;
  const derivedMediaInput = media?.transcript ?? media?.caption ?? `[${media?.type ?? "media"}]`;
  const input = clampString(message ?? normalizedHistory?.[normalizedHistory.length - 1]?.content ?? derivedMediaInput, runtime.defaults.maxContentLength);

  if (!input) {
    const error = new Error("message is required");
    error.statusCode = 400;
    throw error;
  }

  const tone = detectTone(input);
  const existingProfile = runtime.longTerm.getProfile(safeUserId ?? "default", channelScope);
  const learnedStyle = updateLearnedStyle(existingProfile?.style ?? {}, input);
  const profileWithLearned = { ...existingProfile, style: learnedStyle };
  runtime.longTerm.updateProfile(safeUserId ?? "default", { style: learnedStyle }, channelScope);
  if (pushName && safeUserId) {
    addProfileNicknames(runtime, safeUserId, { pushName }, channelScope);
  }
  const resumedAfterClose = Boolean(existingProfile?.conversationClosedAt);
  const styleHint = buildStyleHint(input, tone, profileWithLearned, normalizedHistory, runtime, safeSessionId);
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
      isDirectTetoCall: ChatService.isDirectTetoCall(input),
      isVulnerable,
      resumedAfterClose,
      tone,
      media,
      recentHistory: recentHistory ?? [],
      closeDecision: effectiveCloseDecision
    });
  }

  const finalCloseDecision =
    mergeBrainCloseDecision(effectiveCloseDecision, brainTurn?.snapshot?.conversationPhase) ??
    effectiveCloseDecision;

  const timingPlan = brainTurn?.timingPlan ?? null;
  const enrichedStyleHint = {
    ...styleHint,
    ...(brainTurn?.snapshot?.trustBond
      ? {
          bondTrust: brainTurn.snapshot.trustBond.trust,
          bondIntimacy: brainTurn.snapshot.trustBond.intimacy
        }
      : {}),
    userCanMirrorLoose:
      styleHint.userCanMirrorLoose &&
      (isOwner ||
        (brainTurn?.snapshot?.trustBond?.intimacy ?? 0) >= 0.42 ||
        styleHint.userAffectionateBurst)
  };

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
    isQuestion: isDirectQuestion,
    groupEngagementActive: Boolean(groupEngagementActive)
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
    !groupEngagementActive &&
    !isReply &&
    finalCloseDecision !== "respond" &&
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
        payload: operationIntent.payload,
        isOwner
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
    runtime.multimodalMemory?.list?.(safeUserId ?? "default", safeChannelId, 3) ?? [],
    3
  );
  const visionText = [
    media?.transcript,
    media?.caption,
    media?.visualDescription
  ]
    .filter(Boolean)
    .join(" ");
  const selfImageDetection = detectTetoInMediaDescription(visionText, {
    mediaType: media?.type ?? null
  });

  const mediaContext = [
    describeMediaForPrompt(media, input) ?? buildMediaContext(media),
    selfImageDetection.isLikelySelf
      ? "[AUTO-RECONHECIMENTO] A mídia parece representar a Kasane Teto (você)."
      : null,
    historicalMultimodalContext ? `[RECENT MULTIMODAL MEMORY]\n${historicalMultimodalContext}` : null
  ]
    .filter(Boolean)
    .join("\n\n") || null;

  const musicLoreBlock =
    mentionsMachineLove(input) && runtime.brainOrchestrator?.music?.getMachineLoveLoreBlock
      ? runtime.brainOrchestrator.music.getMachineLoveLoreBlock()
      : null;

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

  const groupRoster = isGroup
    ? buildGroupRoster(runtime, safeChannelId, { participants })
    : null;

  const replies = await runtime.chatService.handleMessage(
    input,
    {
      userId: safeUserId,
      sessionId: safeSessionId,
      channelId: safeChannelId,
      groupRoster,
      quotedMessage,
      quotedMessageId,
      replyThreadContext,
      isReplyToBot: Boolean(isReplyToBot),
      messageKey,
      styleHint: enrichedStyleHint,
      recentHistoryCount: normalizedHistory?.length ?? 0,
      recentHistory,
      resumedAfterClose,
      userPronouns: existingProfile?.facts?.pronouns ?? null,
      channelMode: channelState.mode,
      documentContext,
      reminderContext,
      mediaContext,
      selfImageDetected: selfImageDetection.isLikelySelf,
      closeDecision: finalCloseDecision,
      brainBlocks: brainTurn?.blocks ?? null,
      brainSnapshot: brainTurn?.snapshot ?? null,
      timingPlan: brainTurn?.timingPlan ?? null,
      brainOrchestratorEnabled: Boolean(runtime.brainOrchestrator?.enabled),
      isGroup,
      groupEngagementActive: Boolean(groupEngagementActive),
      groupAddressKind: groupAddressKind || null,
      speakerName: pushName || null,
      participantId: participantId || null,
      segmentSpeakers: Array.isArray(segmentSpeakers) ? segmentSpeakers : null,
      segmentMultiSpeaker: Boolean(segmentMultiSpeaker),
      isOwner,
      musicLoreBlock,
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

  touchUserActivity(runtime, safeUserId ?? "default", {
    markMessage: true,
    sessionId: safeSessionId
  });

  if (!isGroup && safeUserId) {
    runtime.longTerm.updateProfile(
      safeUserId,
      { facts: { lastDmSessionId: safeSessionId } },
      channelScope
    );
    if (
      replies.length === 0 &&
      (finalCloseDecision === "silent" || finalCloseDecision === "react")
    ) {
      runtime.initiationEngine?.scheduleFromTurn?.({
        userId: safeUserId,
        sessionId: safeSessionId,
        mode: finalCloseDecision === "react" ? "natural_lull" : "post_close",
        closeDecision: finalCloseDecision,
        history: normalizedHistory,
        brainTurn
      });
    }
  }

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
    const profile = profileWithLearned;
    const counts = profile.counts ?? {};
    const nextCounts = {
      abbrev: (counts.abbrev ?? 0) + (style.usesAbbrev ? 1 : 0),
      laughter: (counts.laughter ?? 0) + (style.usesLaughter ? 1 : 0),
      emoji: (counts.emoji ?? 0) + (style.usesEmojis ? 1 : 0)
    };
    const total = Math.max(1, (counts.total ?? 0) + 1);
    const nextStyle = {
      ...learnedStyle,
      prefersAbbrev: nextCounts.abbrev / total > 0.4,
      prefersLaughter: nextCounts.laughter / total > 0.4,
      prefersEmoji: nextCounts.emoji / total > 0.3,
      brevity: style.isShort ? "short" : style.isLong ? "long" : "medium"
    };

    const userNameFact = facts.find((f) => f.type === "user_name");
    runtime.longTerm.updateProfile(safeUserId ?? "default", {
      facts: {
        ...(userNameFact
          ? {
              name: userNameFact.value,
              preferredName: userNameFact.value
            }
          : {}),
        ...(facts.find((f) => f.type === "user_pronouns") ? { pronouns: facts.find((f) => f.type === "user_pronouns").value } : {}),
        lastChannel: isGroup ? "group" : "direct"
      },
      style: nextStyle,
      counts: { ...nextCounts, total }
    }, channelScope);
    if (userNameFact?.value) {
      addProfileNicknames(runtime, safeUserId ?? "default", { userNick: userNameFact.value }, channelScope);
    }

    const profileFacts = runtime.longTerm.getProfile(safeUserId ?? "default", channelScope)?.facts ?? {};
    const displayName =
      profileFacts.preferredName || profileFacts.displayName || profileFacts.name || pushName;
    const prevTetoNicks = new Set((profileFacts.tetoNicknames ?? []).map((n) => String(n).toLowerCase()));
    const capturedTetoNicks = captureTetoNicknamesFromReplies(replies, {
      displayName,
      existing: profileFacts.tetoNicknames ?? []
    });
    for (const tetoNick of capturedTetoNicks) {
      if (!prevTetoNicks.has(String(tetoNick).toLowerCase())) {
        addProfileNicknames(runtime, safeUserId ?? "default", { tetoNick }, channelScope);
      }
    }
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
    timingPlan,
    groupRoster
  };
}
