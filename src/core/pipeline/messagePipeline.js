import { detectTone } from "../memory/toneDetector.js";
import { extractFacts, extractStyle, isMeaningful, isMessyLaughterMessage, maxConsecutiveKRun } from "../memory/extractor.js";
import { analyzeInformalTyping } from "../memory/informalTyping.js";
import { formatLearnedStyleForPrompt, updateLearnedStyle } from "../memory/userStyleLearner.js";
import { detectDocumentIntent } from "../../modules/documents/documentIntent.js";
import { buildDocumentContextPayload } from "../../modules/documents/documentContextBuilder.js";
import { detectReminderIntent } from "../../modules/reminders/reminderIntent.js";
import { shouldRespondToMediaOnly } from "../media/mediaSpamGate.js";
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
import { detectImageGenerationIntent } from "../media/imageGenerationIntent.js";
import { detectAgentUrlDownloadIntent } from "../media/agentUrlDownloadIntent.js";
import {
  detectVisualTeaching,
  isMediaDescribeRequest
} from "../media/visualKnowledgeIntent.js";
import { mergeBrainCloseDecision } from "../brain/ConversationPhaseEngine.js";
import { isOwnerContact, touchUserActivity } from "../channels/userActivity.js";
import { fixMisaddressedOwnerNameInReplies, isPlausibleHumanNickname } from "../channels/profileFacts.js";
import {
  buildChannelTimelineForPrompt,
  DEFAULT_CHANNEL_HISTORY_LIMIT,
  timelineToHistoryRows
} from "../channels/channelTimeline.js";
import { buildGroupRoster } from "../channels/groupRoster.js";
import { extractLinks, formatLinksForPrompt } from "../../modules/web/linkReader.js";
import { detectWeatherQuestion, formatWeatherForPrompt } from "../../modules/web/weather.js";
import {
  addProfileNicknames,
  captureTetoNicknamesFromReplies
} from "../channels/waIdentity.js";
import {
  applyUserBoundary,
  clearUserBoundaryFacts,
  detectUserBoundary,
  isBoundaryReopening,
  isUserBoundaryActive,
  userBoundarySnapshot
} from "../channels/userBoundaryDetect.js";
import { scoreSleepDisturbance } from "../life/sleepDisturbanceDetect.js";
import { contextualSeed, chance } from "../brain/rng.js";
import { RESPONSE_MODES, shouldStartTypingIndicator } from "./responseModes.js";

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

/** O que um membro disse numa rajada de grupo: nome, pronome, fatos e resumo — no perfil DELE, escopo do grupo. */
function learnFromGroupSpeaker(runtime, part, { channelId, channelScope }) {
  const text = String(part?.message ?? "").trim();
  if (!text) return;
  const facts = extractFacts(text);
  for (const fact of facts) {
    runtime.longTerm.save({ tags: [fact.type], type: fact.type, value: fact.value, userId: part.userId, channelId, channelScope });
  }
  const nameFact = facts.find((f) => f.type === "user_name" && isPlausibleHumanNickname(f.value));
  const pronouns = facts.find((f) => f.type === "user_pronouns")?.value;
  if (nameFact || pronouns) {
    runtime.longTerm.updateProfile(
      part.userId,
      { facts: { ...(nameFact ? { name: nameFact.value, preferredName: nameFact.value } : {}), ...(pronouns ? { pronouns } : {}) } },
      channelScope
    );
  }
  if (isMeaningful(text)) {
    runtime.longTerm.addMediumTerm(part.userId, { summary: text, timestamp: new Date().toISOString(), channelId }, 20, channelScope);
  }
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
    segmentParts = null,
    groupCatchUp = false,
    groupCatchUpSkipped = 0,
    sleepCatchUp = false,
    deferredCatchUp = null,
    sleepCatchUpCount = 0,
    sleepDisturbedWake = false,
    sleepTemporarilyAwake = false,
    tempWakeGrogginess = 0,
    tempWakeExtensionCount = 0,
    sleepGroggy = false,
    batchedCount = 1,
    isOwner: isOwnerFlag = null,
    mainObserveOnly = false,
    tetosCommand = false,
    onLlmToken = null,
    automateRuns = null,
    automateActiveRuns = null
  } = payload;
  const isTetosBypass = Boolean(tetosCommand);
  const effectiveCloseDecision = isTetosBypass ? "open" : (closeDecision ?? null);
  const safeUserId = typeof userId === "string" ? userId.slice(0, runtime.defaults.maxIdLength) : userId;
  const safeSessionId = typeof sessionId === "string" ? sessionId.slice(0, runtime.defaults.maxIdLength) : sessionId;
  const safeChannelId = typeof channelId === "string" && channelId.trim()
    ? channelId.slice(0, runtime.defaults.maxIdLength * 3)
    : (isGroup ? `group:${safeSessionId ?? safeUserId ?? "default"}` : `direct:${safeUserId ?? "default"}`);
  const isUiDesktopChannel = safeChannelId === "ui-desktop";
  const channelScope = isGroup ? `group:${safeChannelId.replace(/^group:/, "")}` : "direct";
  // Rajada de várias pessoas: a última pode ser a dona, mas o texto não é só dela.
  const isOwner =
    !(isGroup && segmentMultiSpeaker) &&
    (isOwnerFlag === true || (isOwnerFlag !== false && isOwnerContact(runtime, safeChannelId, safeUserId)));

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

  const historyCap = Math.max(8, Number(runtime.defaults.maxHistory) || DEFAULT_CHANNEL_HISTORY_LIMIT);
  const effectiveHistoryCap = Number(batchedCount) > 1 ? Math.max(historyCap, 40) : historyCap;
  const channelTimeline = buildChannelTimelineForPrompt(runtime, {
    channelId: safeChannelId,
    limit: effectiveHistoryCap
  });

  if (channelTimeline.entries.length) {
    normalizedHistory = timelineToHistoryRows(channelTimeline.entries);
  }

  const recentHistory = normalizedHistory?.length ? normalizedHistory.slice(-effectiveHistoryCap) : null;

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
  const boundaryDetected = detectUserBoundary(input);
  if (boundaryDetected.level !== "none") {
    const boundaryFacts = applyUserBoundary(existingProfile?.facts ?? {}, input);
    if (boundaryFacts) {
      runtime.longTerm.updateProfile(
        safeUserId ?? "default",
        { facts: { ...(existingProfile?.facts ?? {}), ...boundaryFacts } },
        channelScope
      );
    }
  } else if (
    isUserBoundaryActive(existingProfile) &&
    (isBoundaryReopening(input) || (isReplyToBot && String(input).trim().length >= 4))
  ) {
    runtime.longTerm.updateProfile(
      safeUserId ?? "default",
      { facts: clearUserBoundaryFacts(existingProfile?.facts ?? {}) },
      channelScope
    );
  }

  if (boundaryDetected.level === "hard" && !isGroup && !isTetosBypass) {
    runtime.metrics?.increment?.("pipeline.boundary.set");
    runtime.shortTerm?.add?.(
      { role: "user", content: input, meta: { userId: safeUserId, boundary: true } },
      safeSessionId ?? "default"
    );
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy: { allowed: true, mode: RESPONSE_MODES.USER_BOUNDARY_SET },
      closeDecision: "silent"
    };
  }

  const profileAfterBoundary = runtime.longTerm.getProfile(safeUserId ?? "default", channelScope);
  const userBoundary = userBoundarySnapshot(profileAfterBoundary);
  let sleepSnap = runtime.brainOrchestrator?.life?.sleep?.getSnapshot?.() ?? {};

  const styleHint = buildStyleHint(input, tone, profileWithLearned, normalizedHistory, runtime, safeSessionId);
  const groupMention = ChatService.extractGroupMention(input);
  const isVulnerable = detectVulnerability(input);
  const isDirectQuestion = ChatService.isLikelyQuestion(input);
  const effectiveMention = isDirectMention || Boolean(groupMention);

  const lastMessageAt = runtime.timeStore?.getLastMessage?.(safeUserId, safeSessionId);
  const gapSinceLastMs = lastMessageAt ? Math.max(0, Date.now() - Date.parse(lastMessageAt)) : null;

  let brainTurn = null;
  if (!isUiDesktopChannel && runtime.brainOrchestrator?.tickTurn) {
    brainTurn = await runtime.brainOrchestrator.tickTurn({
      message: input,
      userId: safeUserId,
      sessionId: safeSessionId,
      channelId: safeChannelId,
      channelScope: isGroup ? `group:${safeChannelId}` : "direct",
      isGroup,
      isOwner,
      isDirectMention: effectiveMention,
      isReply,
      isDirectQuestion,
      isDirectTetoCall: ChatService.isDirectTetoCall(input),
      isVulnerable,
      resumedAfterClose,
      gapSinceLastMs,
      tone,
      media,
      recentHistory: recentHistory ?? [],
      closeDecision: effectiveCloseDecision
    });
  }

  const finalCloseDecision = isTetosBypass
    ? "open"
    : mergeBrainCloseDecision(effectiveCloseDecision, brainTurn?.snapshot?.conversationPhase) ??
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
  const policy = isTetosBypass
    ? { allowed: true, reason: "tetos-command", mode: RESPONSE_MODES.FULL }
    : runtime.channelRegistry.shouldRespond({
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

  if (!policy.allowed && !isTetosBypass) {
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

  if (sleepSnap.isAvailable === false && safeChannelId === "ui-desktop") {
    const sleep = runtime.brainOrchestrator?.life?.sleep;
    sleep?.checkTemporaryWake?.();
    const wakeText = String(message ?? input ?? "").trim();
    const disturbScore = Math.max(scoreSleepDisturbance(wakeText, { floodCount: 3 }), 0.72);
    // Acorda só pro app (a dona chamou ali); os outros chats continuam esperando de manhã.
    sleep?.attemptDisturbanceWake?.({ score: disturbScore, floodCount: 3, chatId: "ui-desktop", isOwner: true });
    sleepSnap = sleep?.getSnapshot?.() ?? sleepSnap;
  }

  const boundaryBlocksReply =
    !isGroup &&
    userBoundary.active &&
    userBoundary.level === "hard" &&
    boundaryDetected.level === "none" &&
    !isBoundaryReopening(input) &&
    !(isReplyToBot && trimmedInput.length >= 4);

  const mediaOnlyWithoutAddress =
    !isGroup &&
    media?.type &&
    !String(message ?? "").trim() &&
    !effectiveMention &&
    !isReply &&
    !shouldRespondToMediaOnly({
      media,
      isDirect: effectiveMention,
      isReply,
      isReplyToBot: Boolean(isReplyToBot),
      hasVisionOrTranscript: Boolean(String(media?.transcript ?? "").trim()),
      userId: safeUserId
    });

  // timing_silence só corta resposta em grupo sem menção; no privado sempre gera reply.
  const timingSilenceSkip =
    isGroup &&
    timingPlan?.silenceAppropriate &&
    !effectiveMention &&
    !groupEngagementActive &&
    !isReply &&
    finalCloseDecision !== "respond" &&
    !directSubstantive;

  // Dormindo/ocupada/na rua é decidido antes (porta de disponibilidade do WhatsApp guarda e responde
  // depois); aqui nada mais é descartado em silêncio.

  if (boundaryBlocksReply && !isTetosBypass) {
    runtime.metrics?.increment?.("pipeline.boundary.hold");
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy: { ...policy, mode: RESPONSE_MODES.USER_BOUNDARY },
      closeDecision: "silent",
      timingPlan
    };
  }

  if (mediaOnlyWithoutAddress) {
    runtime.metrics?.increment?.("pipeline.media.wait");
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy: { ...policy, mode: RESPONSE_MODES.MEDIA_WAIT },
      timingPlan
    };
  }

  if (timingSilenceSkip && !isTetosBypass) {
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
      policy: { ...policy, mode: RESPONSE_MODES.TIMING_SILENCE },
      timingPlan
    };
  }

  if (!runtime.defaults.replyEnabled || mainObserveOnly) {
    runtime.logger?.log?.("pipeline.observe_only", {
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      mainObserveOnly: Boolean(mainObserveOnly)
    });
    runtime.metrics?.increment?.("pipeline.observe_only");
    return {
      replies: [],
      userId: safeUserId ?? "default",
      sessionId: safeSessionId ?? "default",
      channelId: safeChannelId,
      input,
      tone,
      policy: { ...policy, mode: RESPONSE_MODES.LEARN_ONLY }
    };
  }

  // Busca fora do ar (ex.: 503 do buscador) não derruba a resposta: segue sem resultados e avisa o modelo.
  let searchResult = null;
  let searchFailed = false;
  try {
    searchResult = await runtime.searchModule?.handle?.(input);
  } catch (error) {
    searchFailed = true;
    runtime.metrics?.increment?.("search.failed");
    console.warn(`[search] falhou: ${error?.message ?? error}`);
  }
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
    : searchFailed
      ? {
          searchQuery: input,
          searchResults: "(a pesquisa na internet falhou agora — responda com o que você já sabe, avise de leve que não conseguiu pesquisar e não invente dados recentes)"
        }
      : {};

  // Link que mandaram (ou citaram perguntando "viu isso?"): ela abre e comenta — só baixa se pedirem.
  let linkMeta = {};
  if (runtime.linkReader && !detectAgentUrlDownloadIntent(input, { quotedMessage })) {
    const quotedLinkAsked =
      extractLinks(quotedMessage ?? "").length && /(?<!\p{L})(isso|esse|essa|viu|olha|v[eê]|acha|achou|assiste|assistiu|l[eê]|leu)(?!\p{L})/iu.test(input);
    const linkText = extractLinks(input).length ? input : quotedLinkAsked ? quotedMessage : "";
    if (linkText) {
      try {
        const items = await runtime.linkReader.readAll(linkText, { max: 2 });
        const linkContext = formatLinksForPrompt(items);
        if (linkContext) {
          linkMeta = {
            linkContext,
            linkSummary: items
              .filter((i) => !i.failed)
              .map((i) => `${i.site}: ${i.title ?? i.text?.slice(0, 80) ?? i.kind}`)
              .join(" | ")
          };
        }
      } catch (error) {
        console.warn(`[links] falhou: ${error?.message ?? error}`);
      }
    }
  }

  // Perguntou do tempo: olha a previsão de verdade (padrão: São Paulo, onde ela mora).
  let weatherMeta = {};
  const weatherAsk = runtime.weather ? detectWeatherQuestion(input) : null;
  if (weatherAsk) {
    try {
      const forecast = await runtime.weather.forecast(weatherAsk.city ?? "São Paulo");
      const weatherContext = formatWeatherForPrompt(forecast, weatherAsk);
      if (weatherContext) weatherMeta = { weatherContext };
    } catch (error) {
      console.warn(`[clima] falhou: ${error?.message ?? error}`);
    }
  }

  // PV da dona: ela pode pedir coisa no PC pelo zap (AutoMate via API). Só oferece se o PC estiver online.
  const automatePcOnline =
    isOwner && !isGroup && runtime.automateBridge?.enabled ? await runtime.automateBridge.isPcOnline() : null;

  const confirmationReply = detectConfirmationReply(input);
  let confirmationResult = null;
  if (confirmationReply !== null) {
    const pending = runtime.pendingConfirmations?.findLatest?.(safeUserId ?? "default");
    if (pending) {
      if (confirmationReply === true) {
        confirmationResult = runtime.operationRouter.execute({
          type: pending.type,
          userId: safeUserId ?? "default",
          payload: { ...(pending.payload ?? {}), confirmed: true },
          isOwner
        });
      } else {
        confirmationResult = { cancelled: true, message: "Operação cancelada." };
      }
      runtime.pendingConfirmations?.resolve?.(safeUserId ?? "default");
    }
  }

  const slashCommandResult = runtime.chatCommandRouter?.execute?.({
    text: input,
    userId: safeUserId ?? "default",
    isOwner
  });

  // Documentos locais são da dona: terceiros não leem nem escrevem arquivos do computador dela.
  const documentIntent = isOwner && runtime.documentModule?.canHandle?.(input)
    ? detectDocumentIntent(input)
    : null;
  if (documentIntent) {
    runtime.metrics?.increment?.(`documents.intent.${documentIntent.type}`);
  }
  const documentPayload = buildDocumentContextPayload(documentIntent, runtime.documentModule);
  const documentContext = documentPayload?.text ?? null;

  const reminderTz = runtime.defaults.dailyReportTz ?? "America/Sao_Paulo";
  const reminderIntent = detectReminderIntent(input, { timeZone: reminderTz });
  let reminderContext = null;
  if (reminderIntent?.type === "create") {
    const reminder = runtime.reminders.create({
      userId: safeUserId ?? "default",
      // JID do chat (DM ou grupo) — a entrega vai para onde o pedido foi feito.
      chatJid: String(safeChannelId ?? "").includes("@") ? safeChannelId : null,
      text: reminderIntent.text,
      dueAt: reminderIntent.dueAt ?? null
    });
    const when = new Intl.DateTimeFormat("pt-BR", { timeZone: reminderTz, weekday: "short", hour: "2-digit", minute: "2-digit" })
      .format(new Date(reminder.dueAt));
    reminderContext = `Lembrete criado: "${reminder.text}" para ${when} (horário local). Confirme de leve, sem repetir o id.`;
    runtime.metrics?.increment?.("reminders.created");
  } else if (reminderIntent?.type === "needs_time") {
    reminderContext = `A pessoa pediu lembrete de "${reminderIntent.text}" mas sem dizer quando. Pergunte o horário (ex.: "daqui 30 min", "às 15h", "amanhã às 9") — ainda NÃO foi criado.`;
  } else if (reminderIntent?.type === "list") {
    // No grupo, só os lembretes pedidos ali; no PV, todos os da pessoa.
    const chatJid = String(safeChannelId ?? "").includes("@") ? safeChannelId : null;
    const reminders = runtime.reminders
      .list(safeUserId ?? "default")
      .filter((item) => !isGroup || !chatJid || item.chatJid === chatJid);
    reminderContext = reminders.length
      ? reminders.map((item) => `- ${item.id}: ${item.text}${item.done ? " [done]" : ""}`).join("\n")
      : "Nenhum lembrete encontrado.";
  } else if (reminderIntent?.type === "done") {
    const mine = runtime.reminders.list(safeUserId ?? "default").some((item) => item.id === reminderIntent.id);
    const done = mine ? runtime.reminders.markDone(reminderIntent.id) : null;
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
    runtime.multimodalMemory?.list?.(
      isGroup ? null : safeUserId ?? "default",
      safeChannelId,
      6
    ) ?? [],
    6
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

  const visualKnowledgeMatches =
    visionText && runtime.visualKnowledge?.match
      ? runtime.visualKnowledge.match(visionText, {
          userId: safeUserId,
          channelId: safeChannelId,
          limit: 3
        })
      : [];
  const visualKnowledgePrompt = runtime.visualKnowledge?.formatForPrompt?.(visualKnowledgeMatches);

  const teachingOnQuoted =
    isReply && quotedMessageId && !media?.type
      ? detectVisualTeaching(input)
      : null;
  const teachingOnCurrent = detectVisualTeaching(input);
  const teaching = teachingOnCurrent ?? teachingOnQuoted;

  if (teaching && runtime.visualKnowledge?.learn) {
    const teachVision =
      visionText ||
      String(quotedMessage ?? replyThreadContext?.quoted?.text ?? "").trim();
    if (teachVision) {
      runtime.visualKnowledge.learn({
        userId: safeUserId,
        channelId: safeChannelId,
        label: teaching.label,
        visionText: teachVision,
        taughtByText: teaching.sourceText,
        messageId: media ? messageKey?.id : quotedMessageId ?? messageKey?.id,
        confidence: teaching.confidence
      });
      runtime.selectiveMemory?.remember?.({
        userId: safeUserId ?? "default",
        channelId: safeChannelId,
        content: `[visual] ${teaching.label}: ${teachVision.slice(0, 160)}`,
        source: "visual_teaching"
      });
    }
  }

  const learnedSelfFromKnowledge = visualKnowledgeMatches.some(
    (m) => m.label === "kasane_teto" && (m.matchScore ?? 0) >= 0.35
  );
  const mediaDescribeRequest = isMediaDescribeRequest(input);

  const mediaContext = [
    describeMediaForPrompt(media, input) ?? buildMediaContext(media),
    selfImageDetection.isLikelySelf || learnedSelfFromKnowledge
      ? "[AUTO-RECONHECIMENTO] A mídia parece representar a Kasane Teto (você)."
      : null,
    visualKnowledgePrompt
      ? `[CONHECIMENTO VISUAL APRENDIDO]\n${visualKnowledgePrompt}\nUse isso para validar o que vê — se bater com a mídia atual, reconheça com confiança.`
      : null,
    mediaDescribeRequest
      ? "[PEDIDO DE DESCRIÇÃO DETALHADA] Descreva TUDO que vê na mídia (objetos, cores, expressão, texto na imagem, estilo). Relacione com memória/conhecimento aprendido se souber identificar algo."
      : null
  ]
    .filter(Boolean)
    .join("\n\n") || null;

  const musicLoreBlock =
    mentionsMachineLove(input) && runtime.brainOrchestrator?.music?.getMachineLoveLoreBlock
      ? runtime.brainOrchestrator.music.getMachineLoveLoreBlock()
      : null;

  const profileForRel =
    runtime.longTerm.getProfile(safeUserId ?? "default", channelScope) ?? existingProfile;
  const partnerDisplayName =
    profileForRel?.facts?.preferredName ||
    profileForRel?.facts?.displayName ||
    profileForRel?.facts?.name ||
    pushName ||
    null;

  let relationshipMeta = null;
  if (runtime.relationshipStore && safeUserId) {
    const relTurn = runtime.relationshipStore.processTurn({
      message: input,
      userId: safeUserId,
      displayName: partnerDisplayName,
      runtime,
      trustBond:
        brainTurn?.snapshot?.trustBond ??
        runtime.brainOrchestrator?.trust?.getBond?.(safeUserId, channelScope) ??
        null,
      isGroup
    });
    relationshipMeta = {
      relationshipContext: relTurn.promptContext,
      flirtFromNonPartner: Boolean(relTurn.flirtFromNonPartner),
      relationshipChanged: Boolean(relTurn.changed),
      relationshipEvent: relTurn.event ?? null
    };
    if (relTurn.changed && runtime.brainOrchestrator?.memory?.recordEpisode) {
      const statusLabel = relTurn.promptContext?.lines?.[1] ?? "relacionamento atualizado";
      runtime.brainOrchestrator.memory.recordEpisode({
        userId: safeUserId ?? "default",
        channelId: safeChannelId,
        channelScope: isGroup ? `group:${safeChannelId}` : "direct",
        summary: `[relacionamento] ${statusLabel}`.slice(0, 280),
        userMessage: input,
        assistantReplies: [],
        tone: "warm",
        ts: new Date().toISOString(),
        salience: 0.85
      });
      runtime.selectiveMemory?.remember?.({
        userId: safeUserId ?? "default",
        channelId: safeChannelId,
        content: statusLabel.slice(0, 200),
        source: "relationship_milestone"
      });
    }
  }

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
      message: visionText || input,
      messageId: payload?.messageId || messageKey?.id
    });
    runtime.metrics?.increment?.("multimodal.saved");
  }

  const groupRoster = isGroup
    ? buildGroupRoster(runtime, safeChannelId, { participants })
    : null;

  if (
    shouldStartTypingIndicator({
      finalCloseDecision,
      replyEnabled: runtime.defaults.replyEnabled,
      mainObserveOnly
    }) &&
    typeof payload.onGenerationStart === "function"
  ) {
    await payload.onGenerationStart();
  }

  let replies = await runtime.chatService.handleMessage(
    input,
    {
      userId: safeUserId,
      sessionId: safeSessionId,
      channelId: safeChannelId,
      groupRoster,
      quotedMessage,
      quotedMessageId,
      incomingMessageId: messageKey?.id ?? payload?.messageId ?? null,
      replyThreadContext,
      isReply: Boolean(isReply),
      isReplyToBot: Boolean(isReplyToBot),
      messageKey,
      media,
      mediaDescribeRequest,
      visualKnowledgeContext: visualKnowledgePrompt,
      styleHint: enrichedStyleHint,
      recentHistoryCount: channelTimeline.entries.length || normalizedHistory?.length || 0,
      recentHistory,
      channelTimelineText: channelTimeline.text || null,
      resumedAfterClose,
      userPronouns: existingProfile?.facts?.pronouns ?? null,
      channelMode: channelState.mode,
      documentContext,
      reminderContext,
      mediaContext,
      selfImageDetected: selfImageDetection.isLikelySelf || learnedSelfFromKnowledge,
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
      groupCatchUp: Boolean(groupCatchUp),
      groupCatchUpSkipped: Number(groupCatchUpSkipped) || 0,
      sleepCatchUp: Boolean(sleepCatchUp),
      deferredCatchUp,
      sleepCatchUpCount: Number(sleepCatchUpCount) || 0,
      sleepDisturbedWake: Boolean(sleepDisturbedWake),
      sleepTemporarilyAwake: Boolean(sleepTemporarilyAwake),
      tempWakeGrogginess: Number(tempWakeGrogginess) || 0,
      tempWakeExtensionCount: Number(tempWakeExtensionCount) || 0,
      sleepGroggy: Boolean(sleepGroggy) || sleepSnap.state === "groggy",
      batchedCount: Number(batchedCount) || 1,
      sleepState: sleepSnap.state ?? null,
      isOwner,
      tetosCommand: isTetosBypass,
      musicLoreBlock,
      repertoireModeActive: Boolean(runtime.stickerRepertoireMode?.isActive?.(safeUserId)),
      stickersPath: runtime.defaults.stickersPath,
      imageGenIntent: detectImageGenerationIntent(input),
      urlDownloadIntent: detectAgentUrlDownloadIntent(input, {
        quotedMessage,
        quotedMessageId,
        isReply
      }),
      historicalMultimodalContext,
      ...(typeof onLlmToken === "function" && safeChannelId === "ui-desktop"
        ? { onLlmToken }
        : {}),
      ...(safeChannelId === "ui-desktop" && Array.isArray(automateRuns) && automateRuns.length ? { automateRuns } : {}),
      ...(safeChannelId === "ui-desktop" && Array.isArray(automateActiveRuns) && automateActiveRuns.length ? { automateActiveRuns } : {}),
      ...(relationshipMeta ?? {}),
      ...searchMeta,
      ...linkMeta,
      ...weatherMeta,
      automateFromWhatsApp: automatePcOnline,
      peopleMemoryLines:
        runtime.peopleMemory?.promptLines?.(isGroup ? `group:${safeChannelId}` : safeUserId ?? "default", channelScope, {
          name: isGroup ? null : partnerDisplayName,
          isGroup
        }) ?? [],
      ...operationMeta
    },
    normalizedHistory,
    tone
  );

  if (!isGroup && Array.isArray(replies) && replies.length) {
    const interlocutorName =
      partnerDisplayName ||
      pushName ||
      existingProfile?.facts?.displayName ||
      existingProfile?.facts?.name ||
      null;
    replies = fixMisaddressedOwnerNameInReplies(replies, {
      isOwner,
      interlocutorName
    });
  }

  if (runtime.brainOrchestrator?.logTurn) {
    const shouldLogMind =
      !runtime.defaults.mindLogOnlyReplies || (Array.isArray(replies) && replies.length > 0);
    if (shouldLogMind) {
      runtime.brainOrchestrator.logTurn({
        turnId: `${safeSessionId}-${Date.now()}`,
        input: { message: input, channelId: safeChannelId, isGroup, media },
        brain: brainTurn?.snapshot ?? {},
        timingPlan,
        output: { replies, count: replies.length }
      });
    }
  }

  // Episódio só de conteúdo de verdade ("[sticker]" sozinho não é lembrança).
  if (replies.length > 0 && runtime.brainOrchestrator?.memory?.recordEpisode && isMeaningful(input) && !/^\[[^\]]+\]$/.test(input.trim())) {
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

  runtime.initiativeState?.noteUserMessage?.(safeUserId ?? "default");
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
  }

  if (replies.length > 0 && resumedAfterClose) {
    runtime.longTerm.updateProfile(safeUserId ?? "default", { conversationClosedAt: null }, channelScope);
  }

  // Rajada de várias pessoas no grupo: cada um aprende só com o que ELE disse — não tudo em nome do último.
  const multiSpeakerParts =
    isGroup && Array.isArray(segmentParts) && new Set(segmentParts.map((p) => p?.userId)).size > 1 ? segmentParts : null;
  const learnInput = multiSpeakerParts
    ? multiSpeakerParts.filter((p) => p.userId === safeUserId).map((p) => p.message).join("\n")
    : input;
  if (multiSpeakerParts && replies.length > 0) {
    for (const part of multiSpeakerParts) {
      if (part.userId && part.userId !== safeUserId) learnFromGroupSpeaker(runtime, part, { channelId: safeChannelId, channelScope });
    }
  }

  const facts = replies.length > 0 && learnInput ? extractFacts(learnInput) : [];
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

    const style = extractStyle(learnInput || input);
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

    const userNameFact = facts.find((f) => f.type === "user_name" && isPlausibleHumanNickname(f.value));
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
    const capturedTetoNicks = multiSpeakerParts ? [] : captureTetoNicknamesFromReplies(replies, {
      displayName,
      existing: profileFacts.tetoNicknames ?? []
    });
    for (const tetoNick of capturedTetoNicks) {
      if (!prevTetoNicks.has(String(tetoNick).toLowerCase())) {
        addProfileNicknames(runtime, safeUserId ?? "default", { tetoNick }, channelScope);
      }
    }
  }

  if (replies.length > 0 && learnInput && isMeaningful(learnInput)) {
    runtime.longTerm.addMediumTerm(safeUserId ?? "default", {
      summary: learnInput,
      timestamp: new Date().toISOString(),
      channelId: safeChannelId
    }, 20, channelScope);
    runtime.longTerm.pruneMediumTerm(safeUserId ?? "default", 20, channelScope);
  }

  const memoryCandidates = replies.length > 0 && learnInput
    ? runtime.selectiveMemory.buildCandidate(learnInput, facts)
    : [];
  for (const candidate of memoryCandidates) {
    runtime.selectiveMemory.remember({
      userId: safeUserId ?? "default",
      channelId: safeChannelId,
      content: candidate,
      source: facts.length ? "fact" : "message"
    });
  }

  // Caderno de memória: anota o que cada um disse e o que ela respondeu (consolida quando esfriar).
  if (runtime.peopleMemory && !isTetosBypass) {
    const notebookId = isGroup ? `group:${safeChannelId}` : safeUserId ?? "default";
    const parts = multiSpeakerParts ?? [{ speakerName: partnerDisplayName ?? pushName, message: input }];
    for (const part of parts) {
      runtime.peopleMemory.record({
        userId: notebookId,
        scope: channelScope,
        name: isGroup ? null : partnerDisplayName ?? pushName ?? null,
        speaker: part.speakerName ?? null,
        role: "user",
        text: part.message
      });
    }
    for (const reply of replies) {
      runtime.peopleMemory.record({ userId: notebookId, scope: channelScope, role: "teto", text: reply });
    }
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
