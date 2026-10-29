// Orquestrador de conversa do WhatsApp: fila/batch por sessão, geração, interrupção e envio das bolhas e ações.
import { handleIncomingMessage } from "../../../app/createRuntime.js";
import { withGenerationSlot } from "../../../infra/concurrency/generationSlot.js";
import { jidNormalizedUser, downloadContentFromMessage } from "baileys";
import { planWhatsAppReaction } from "../inbound/reactionPlanner.js";
import { resolvePassiveModeAction } from "../../../core/channels/passiveModeAction.js";
import { RESPONSE_MODES, RESPONSE_OUTPUTS } from "../../../core/pipeline/responseModes.js";
import { addDecisionStep, finalizeDecisionTrace } from "../../../infra/observability/decisionTrace.js";
import { resolveStickerAsset } from "../media/stickerAssets.js";
import { resolveOutgoingActions, sanitizeOutgoingActions } from "../../../modules/chat/chatService.js";
import { formatMediaInputText } from "../../../core/channels/mediaTimelineEnrich.js";
import { resolveTimingConfig, estimateTypingDelayMs as estimateTypingFromCfg, estimateFollowupTypingDelayMs as estimateFollowupTypingFromCfg } from "../../../core/timing/timingConfig.js";
import { awaitSendOnce, claimOutboundDedupe, createOutboundMessageId, releaseOutboundDedupe } from "./outboundSend.js";
import { applyQuotedContextToPayload, buildOutgoingQuoteKey, resolveOutgoingQuoteId, buildQuoteKeyFromMessageId } from "../inbound/messageContext.js";
import { resolveVerifiedQuoteKey } from "../inbound/quoteMessageResolver.js";
import { resolveMediaByMessageId } from "../commands/agentMediaResolver.js";
import { saveStickerToRepertoireWithVision, logRepertoireVision } from "../media/stickerRepertoire.js";
import { buildGroupRoster } from "../../../core/channels/groupRoster.js";
import { translateAtMentions } from "../inbound/mentionResolver.js";
import { isGroupPriorityEntry } from "./groupTurnPlanner.js";
import { compactGroupQueueSegments, planFloodAwareGroupSegments, takeNextGroupTurn } from "./groupFloodCoordinator.js";
import { abortPendingHoldStores, computeDirectBatchMs, DM_BURST_MAX_MS, firstBubbleTypingFloorMs, GROUP_BURST_MAX_MS, isMediaHoldEntry, shouldFlushPendingOnIncoming, shouldSkipThinkDelaySleep, shouldSplitBurst, stampMediaHoldStart, textSettleMs, thinkDelaySleepMs, TYPING_RECHECK_MS, visionFlushTimeoutMs } from "./directBatchPlanner.js";
import { applyVisionFields, extractPhone, isWaConnectionError, logThinking, sleep } from "../inbound/waHandlerUtils.js";
import { TypingTracker } from "../inbound/typingTracker.js";
import { DEFAULTS } from "../../../infra/config/defaults.js";
import { recentAssistantTurns, regulateBubbles, regulateMessageActions } from "../../../modules/chat/styleRegulator.js";

/** Máximo que a Teto espera antes de mandar a resposta se a pessoa voltou a digitar. */
const PRE_SEND_TYPING_WAIT_MS = 12_000;

async function settleMediaVision(item, timeoutMs = 8000) {
  const promise = item.mediaVisionPromise ?? item.media?.visionPromise;
  // Item que voltou do disco (mensagem guardada) não tem promessa de verdade — só "{}".
  if (typeof promise?.then !== "function" || !item.media) return item.media;
  try {
    const visualDescription = await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("vision-timeout")), timeoutMs))
    ]);
    item.media = applyVisionFields(item.media, typeof visualDescription === "string" ? visualDescription : null, { skipVision: false });
  } catch {
    if (!item.media.visionAttempted) {
      item.media = applyVisionFields(item.media, item.media.transcript ?? null, { skipVision: false });
    }
  }
  return item.media;
}

function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function createConversationOrchestrator(
  socket,
  runtime,
  {
    chatMessageIndex = null,
    botJid = "",
    botPhone = "",
    logPrefix = "[whatsapp]",
    mediaHistoryStore = null,
    mediaCommandService = null,
    getMediaCommandService = null,
    getWaMessageById = null
  } = {}
) {
  // O orquestrador sobrevive a reconexões; o serviço de mídia é recriado com o socket novo.
  const mediaCommands = () => getMediaCommandService?.() ?? mediaCommandService;
  const timingCfg = resolveTimingConfig(runtime?.defaults ?? {});
  const pendingBySession = new Map();
  const pendingByGroupChannel = new Map();
  const queueBySession = new Map();
  const queueByGroupChannel = new Map();
  const runningBySession = new Set();
  const runningByGroupChannel = new Set();
  const deferredBySession = new Map();
  const typing = new TypingTracker();
  /** Sessões cujo turno atual já começou a mandar bolhas (daí em diante, msg nova vira turno seguinte). */
  const sendingBySession = new Set();
  /** Turno descartado por msg nova antes de enviar — reentra junto com as msgs novas. */
  const supersededBySession = new Map();
  const interruptBySession = new Map();
  /** Incrementado ao desativar grupo — invalida turnos enfileirados/em voo. */
  const groupChannelEpoch = new Map();
  const currentSessionByGroupChannel = new Map();
  /** @type {Map<string, { messagesSinceLastReaction: number, lastReactionAt: number }>} */
  const reactionStateByUser = new Map();

  function waSocket() {
    if (typeof runtime.whatsappGetSocket === "function") {
      return runtime.whatsappGetSocket() ?? socket;
    }
    return runtime.whatsappSockets?.full
      ?? runtime.whatsappSockets?.media
      ?? runtime.whatsappSockets?.main
      ?? socket;
  }

  async function ensureLiveSocket() {
    const current = waSocket();
    if (runtime.whatsappIsConnected?.() && current?.user) return current;
    if (typeof runtime.whatsappWaitConnected === "function") {
      console.warn(`${logPrefix} socket indisponível, aguardando reconexão para enviar`);
      return runtime.whatsappWaitConnected(20000);
    }
    return current;
  }

  /** Envio direto (mídia gerada etc.) pelo socket vivo; queda de conexão não derruba o turno. */
  async function sendRaw(jid, payload) {
    try {
      const live = await ensureLiveSocket();
      return await live.sendMessage(jid, payload);
    } catch (error) {
      if (isWaConnectionError(error)) {
        console.warn(`${logPrefix} envio abortado (conexao fechada) → ${jid}`);
        return null;
      }
      throw error;
    }
  }

  function buildSanitizeMeta(item = {}) {
    return {
      messageKey: item.messageKey,
      messageId: item.messageKey?.id ?? item.messageId ?? null,
      message: item.message ?? "",
      quotedMessageId: item.quotedMessageId ?? null,
      quotedMessage: item.quotedMessage ?? null,
      replyThreadContext: item.replyThreadContext ?? null,
      isReply: item.isReply,
      isReplyToBot: item.isReplyToBot,
      isGroup: item.isGroup,
      isDirectMention: item.isDirectMention,
      groupPriorityAddress: item.groupPriorityAddress,
      groupEngagementActive: item.groupEngagementActive,
      closeDecision: item.closeDecision,
      media: item.media,
      batchedCount: item.batchedCount,
      recentHistory: chatMessageIndex?.getThread?.(item.remoteJid, 5) ?? []
    };
  }

  function mergeDirectEntries(previous, entry) {
    if (!previous || !entry) return entry ? { ...entry, batchedCount: entry.batchedCount ?? 1 } : null;
    const differentQuote =
      entry.isReply &&
      previous.quotedMessageId &&
      entry.quotedMessageId &&
      previous.quotedMessageId !== entry.quotedMessageId;
    if (differentQuote || shouldSplitBurst(previous, entry)) return null;
    const canMergeQuotes =
      !entry.isReply ||
      !previous.isReply ||
      !entry.quotedMessageId ||
      !previous.quotedMessageId ||
      entry.quotedMessageId === previous.quotedMessageId;
    if (!canMergeQuotes) return null;
    const captions = [previous.caption, entry.caption]
      .map((c) => String(c ?? "").trim())
      .filter(Boolean);
    return {
      ...entry,
      message: `${previous.message}\n${entry.message}`.trim(),
      caption: captions.length ? captions.join("\n") : entry.caption ?? previous.caption,
      messageKey: entry.messageKey ?? previous.messageKey,
      media: entry.media ?? previous.media,
      mediaVisionPromise: entry.mediaVisionPromise ?? previous.mediaVisionPromise,
      mediaHoldStartedAt: stampMediaHoldStart(previous, entry),
      quotedMessage: entry.quotedMessage ?? previous.quotedMessage,
      quotedMessageId: entry.quotedMessageId ?? previous.quotedMessageId,
      replyThreadContext: entry.replyThreadContext ?? previous.replyThreadContext,
      isReply: entry.isReply || previous.isReply,
      isReplyToBot: entry.isReplyToBot || previous.isReplyToBot,
      isDirectMention: entry.isDirectMention || previous.isDirectMention,
      groupEngagementActive: entry.groupEngagementActive || previous.groupEngagementActive,
      groupPriorityAddress: entry.groupPriorityAddress || previous.groupPriorityAddress,
      groupAddressKind: entry.groupAddressKind ?? previous.groupAddressKind,
      pushName: entry.pushName ?? previous.pushName,
      isOwner: entry.isOwner || previous.isOwner,
      sleepDisturbedWake: entry.sleepDisturbedWake || previous.sleepDisturbedWake,
      sleepTemporarilyAwake: entry.sleepTemporarilyAwake || previous.sleepTemporarilyAwake,
      tempWakeGrogginess: Math.max(
        entry.tempWakeGrogginess ?? 0,
        previous.tempWakeGrogginess ?? 0
      ),
      tempWakeExtensionCount: Math.max(
        entry.tempWakeExtensionCount ?? 0,
        previous.tempWakeExtensionCount ?? 0
      ),
      sleepGroggy: entry.sleepGroggy || previous.sleepGroggy,
      _coalesceAfterGen: entry._coalesceAfterGen || previous._coalesceAfterGen,
      _postGenTurns: Math.max(entry._postGenTurns ?? 0, previous._postGenTurns ?? 0),
      batchedCount: (previous.batchedCount ?? 1) + (entry.batchedCount ?? 1)
    };
  }

  function abortPendingMediaHold(sessionId, { remoteJid = "", userId = "" } = {}) {
    const keys = [...new Set([sessionId, userId].filter(Boolean))];
    let aborted = false;
    for (const key of keys) {
      if (
        abortPendingHoldStores(
          { pendingBySession, deferredBySession, pendingByGroupChannel },
          { sessionId: key, remoteJid }
        )
      ) {
        aborted = true;
      }
      if (runningBySession.has(key)) {
        bumpInterrupt(key);
        aborted = true;
      }
    }
    return aborted;
  }

  function flushDeferredSession(sessionId) {
    const superseded = supersededBySession.get(sessionId);
    supersededBySession.delete(sessionId);
    let deferred = deferredBySession.get(sessionId);
    if (!deferred) {
      if (superseded) enqueue({ ...superseded });
      return;
    }
    deferredBySession.delete(sessionId);
    // Turno descartado antes de enviar + msgs novas = uma entrada só (a Teto responde tudo de uma vez).
    if (superseded) deferred = mergeDirectEntries(superseded, deferred) ?? deferred;
    if (deferred.batchedCount > 1) {
      console.log(`[whatsapp] deferred batch ${deferred.batchedCount} msgs → 1 reply (${sessionId})`);
    }
    const postGenTurns = deferred._postGenTurns ?? 0;
    if (postGenTurns >= 1) {
      enqueue(deferred);
      return;
    }
    scheduleDirectIncoming({
      ...deferred,
      _coalesceAfterGen: true,
      _postGenTurns: 1
    });
  }

  function buildVerifiedQuoteKey(remoteJid, quoteId, {
    participantJid = null,
    participantId = null,
    hintText = null
  } = {}) {
    if (!quoteId) return null;
    const resolved = resolveVerifiedQuoteKey({
      channelId: remoteJid,
      remoteJid,
      quoteId,
      chatMessageIndex,
      getWaMessageById,
      groupMemory: runtime.groupMemory,
      participantJid,
      participantId,
      hintText
    });
    if (!resolved.quoteKey) {
      if (resolved.reason === "not_found" && resolved.requestedId) {
        console.warn(
          `${logPrefix} quote id inexistente (${resolved.requestedId}) — enviando sem reply`
        );
      }
      return null;
    }
    if (resolved.resolvedFrom && resolved.resolvedFrom !== resolved.messageId) {
      console.log(
        `${logPrefix} quote ${resolved.resolvedFrom} → ${resolved.messageId} (${resolved.reason})`
      );
    }
    return resolved.quoteKey;
  }

  function resolveQuotedWaMessage(quoteKey, remoteJid) {
    const id = quoteKey?.id;
    if (!id) return null;
    const stored = getWaMessageById?.(id);
    if (stored?.key?.id && stored?.message) return stored;
    const indexed = chatMessageIndex?.get(remoteJid, id);
    if (!indexed) return null;
    const text = String(indexed.text ?? "").trim();
    const key = {
      remoteJid: quoteKey.remoteJid ?? remoteJid,
      id,
      fromMe: Boolean(indexed.isFromBot)
    };
    if (indexed.participantJid) key.participant = indexed.participantJid;
    if (/^\[image\]/i.test(text)) {
      return { key, message: { imageMessage: { caption: text.replace(/^\[image\]\s*/i, "") } } };
    }
    if (/^\[sticker\]/i.test(text)) {
      return { key, message: { stickerMessage: {} } };
    }
    return {
      key,
      message: text ? { conversation: text } : { extendedTextMessage: { text: "…" } }
    };
  }

  function resolveActionQuoteKey(quoteId, item, { hintText = null } = {}) {
    if (!quoteId) return null;
    const resolved = resolveVerifiedQuoteKey({
      channelId: item.remoteJid,
      remoteJid: item.remoteJid,
      quoteId,
      chatMessageIndex,
      getWaMessageById,
      groupMemory: runtime.groupMemory,
      participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
      participantId: item.participantId ?? null,
      hintText
    });
    if (!resolved.quoteKey && resolved.reason === "not_found") {
      console.warn(
        `${logPrefix} quote inválido (${resolved.requestedId}) — enviando sem reply`
      );
    } else if (resolved.resolvedFrom && resolved.resolvedFrom !== resolved.messageId) {
      console.log(
        `${logPrefix} quote corrigido ${resolved.resolvedFrom} → ${resolved.messageId} (${resolved.reason})`
      );
    }
    return resolved.quoteKey;
  }

  async function sendReplies(remoteJid, userId, sessionId, replies = [], token = 0, options = {}) {
    runtime.waPresence?.active?.();
    const quoteKey = options?.quoteMessageKey ?? null;
    if (options?.allowReply === false || !runtime.defaults.replyEnabled) return;
    const plan = options?.timingPlan ?? {};
    try {
      for (let index = 0; index < replies.length; index += 1) {
        const content = String(replies[index] ?? "").trim();
        if (!content) continue;
        if (interruptBySession.get(sessionId) !== token) {
          console.warn(
            `${logPrefix} send interrompido bolha ${index + 1}/${replies.length} (interrupt token mismatch)`
          );
          return;
        }
        const remotePhone = extractPhone(remoteJid);
        const len = content.length;
        const isGroup = remoteJid.endsWith("@g.us");
        let needsTyping;
        let typingDelayMs;
        if (isGroup) {
          needsTyping = false;
          typingDelayMs = plan.readDelayMs ? Math.min(plan.readDelayMs, 1200) : 0;
          if (typingDelayMs > 0) await sleep(typingDelayMs);
          typingDelayMs = 0;
        } else if (index > 0) {
          needsTyping = true;
          typingDelayMs = estimateFollowupTypingFromCfg(content, timingCfg);
        } else if (len <= 4) {
          needsTyping = false;
          typingDelayMs = 0;
        } else {
          needsTyping = true;
          const base = index === 0 && plan.typingDelayMs
            ? plan.typingDelayMs
            : estimateTypingFromCfg(content, index, timingCfg);
          const extraDelay = options?.softened ? randBetween(120, 320) : 0;
          typingDelayMs = Math.min(
            timingCfg.typingMaxDelayMs,
            Math.max(firstBubbleTypingFloorMs(timingCfg, {
              isGroup: false,
              batchedCount: options?.batchedCount ?? 1,
              sleepGroggy: options?.sleepGroggy,
              sleepTemporarilyAwake: options?.sleepTemporarilyAwake
            }), base + extraDelay)
          );
        }
        let active = null;
        try {
          active = await ensureLiveSocket();
        } catch (waitError) {
          console.error(`${logPrefix} send aborted, no live socket:`, waitError.message);
          continue;
        }
        if (index === 0 && needsTyping && typingDelayMs > 0) {
          await sleep(randBetween(timingCfg.postModelBeforeBubbleMinMs, timingCfg.postModelBeforeBubbleMaxMs));
        }
        if (needsTyping && typingDelayMs > 0 && typeof active?.sendPresenceUpdate === "function") {
          try {
            await active.sendPresenceUpdate("composing", remoteJid);
            await sleep(typingDelayMs);
            await active.sendPresenceUpdate("paused", remoteJid);
          } catch (error) {
            console.warn(`${logPrefix} typing simulation failed for ${remotePhone}: ${error.message}`);
            if (isWaConnectionError(error)) {
              try {
                active = await ensureLiveSocket();
              } catch (waitError) {
                console.error(`${logPrefix} send aborted after typing, no live socket:`, waitError.message);
                continue;
              }
            }
          }
        }
        if (interruptBySession.get(sessionId) !== token) {
          console.warn(
            `${logPrefix} send interrompido bolha ${index + 1}/${replies.length} após typing (interrupt token mismatch)`
          );
          return;
        }
        const perBubbleQuotes = Array.isArray(options?.quoteMessageKeys) ? options.quoteMessageKeys : [];
        const rawQuote =
          perBubbleQuotes[index] ??
          (index === 0 ? quoteKey : null);
        let normalizedQuote = null;
        if (rawQuote?.id) {
          normalizedQuote = buildVerifiedQuoteKey(remoteJid, rawQuote.id, {
            participantJid: options?.participantJid ?? rawQuote.participant ?? null,
            participantId: options?.participantId ?? null
          });
        }
        if (index === 0 && normalizedQuote?.id) {
          console.log(`${logPrefix} outgoing quote id=${normalizedQuote.id} → ${remoteJid}`);
        }
        runtime.__waRecentOutbound ??= new Map();
        if (!claimOutboundDedupe(runtime.__waRecentOutbound, remoteJid, content)) {
          console.warn(
            `${logPrefix} skip duplicate send → ${remoteJid}: ${content.slice(0, 80)}`
          );
          continue;
        }
        console.log(`${logPrefix} outgoing ${remoteJid}: ${content}`);
        let rosterMembers = options?.groupRoster?.members ?? [];
        if (isGroup && !rosterMembers.length) {
          rosterMembers = buildGroupRoster(runtime, remoteJid).members ?? [];
        }
        const { text: mentionText, mentions } = translateAtMentions(content, rosterMembers);
        const mentionPayload = mentions.length ? { mentions } : {};
        const indexedRow =
          normalizedQuote?.id && chatMessageIndex
            ? chatMessageIndex.get(remoteJid, normalizedQuote.id)
            : null;
        const quotedWa = resolveQuotedWaMessage(normalizedQuote, remoteJid);
        let payload = { text: mentionText, ...mentionPayload };
        if (!quotedWa && normalizedQuote?.id && indexedRow) {
          payload = applyQuotedContextToPayload(payload, normalizedQuote, indexedRow);
        }
        const messageId = createOutboundMessageId();
        const sendOnce = (sock) => {
          const sendOpts = quotedWa
            ? { quoted: quotedWa, messageId }
            : { messageId };
          return sock.sendMessage(remoteJid, payload, sendOpts);
        };
        let sent = null;
        let sendOutcome = "ok";
        try {
          sent = await awaitSendOnce({
            send: () => sendOnce(active),
            isConnectionError: isWaConnectionError,
            onTimeout: () => {
              sendOutcome = "timeout";
              console.warn(
                `${logPrefix} send lento, aguardando envio original (sem reenviar) → ${remoteJid}`
              );
            },
            retrySend: async () => {
              active = await ensureLiveSocket();
              console.warn(`${logPrefix} reenviando após reconexão → ${remoteJid}`);
              return sendOnce(active);
            }
          });
        } catch (error) {
          sendOutcome = "error";
          console.error(`${logPrefix} send failed to ${remoteJid}:`, error.message);
          sent = null;
        }
        if (!sent && sendOutcome !== "timeout") {
          releaseOutboundDedupe(runtime.__waRecentOutbound, remoteJid, content);
        }
        const sentId = sent?.key?.id ?? sent?.message?.key?.id ?? null;
        if (sentId && chatMessageIndex) {
          chatMessageIndex.append({
            channelId: remoteJid,
            messageId: sentId,
            actorId: "teto",
            text: content,
            isFromBot: true,
            remoteJid,
            quotedMessageId: normalizedQuote?.id ?? null,
            participantJid: active?.user?.id ? jidNormalizedUser(active.user.id) : null,
            tetosOneShot: Boolean(options?.tetosCommand)
          });
        }
        if (index < replies.length - 1) {
          const planned = options?.bubbleDelays?.[index + 1];
          const interPartDelayMs = !isGroup
            ? randBetween(timingCfg.followupGapMinMs ?? 60, timingCfg.followupGapMaxMs ?? 160)
            : Number.isFinite(planned) && planned > 0
              ? planned
              : randBetween(timingCfg.multiPartDelayMinMs, timingCfg.multiPartDelayMaxMs);
          await sleep(interPartDelayMs);
        }
      }
    } finally {
      const live = waSocket();
      if (typeof live?.sendPresenceUpdate === "function") {
        try {
          await live.sendPresenceUpdate("paused", remoteJid);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function processQueueItem(item) {
    const allowReply = runtime.defaults.replyEnabled && !item.mainObserveOnly;
    const sessionId = item.sessionId ?? item.userId;
    const groupEpoch =
      item.isGroup && item.remoteJid ? (groupChannelEpoch.get(item.remoteJid) ?? 0) : null;
    const activation = runtime.tetoActivation;
        let outputKind = RESPONSE_OUTPUTS.SILENT;
        addDecisionStep(item.decisionTrace, "queue.processing", {
          allowReply,
          closeDecision: item.closeDecision ?? null
        });
        const abortGroupTurn = (reason) => {
          addDecisionStep(item.decisionTrace, "queue.aborted", { reason });
          finalizeDecisionTrace(runtime, item.decisionTrace, {
            activation: "group_blocked",
            output: RESPONSE_OUTPUTS.IGNORED
          });
        };
        if (shouldDropGroupQueueItem(item, groupEpoch, activation)) {
          abortGroupTurn("group_deactivated");
          return;
        }
        if (item.isGroup && item.remoteJid) {
          currentSessionByGroupChannel.set(item.remoteJid, sessionId);
        }
        const token = Date.now();
        interruptBySession.set(sessionId, token);
        sendingBySession.delete(sessionId);
        const historyMark = runtime.shortTerm?.mark?.(sessionId) ?? null;
        // No grupo, "o que ela já disse" é o que disse pra todo mundo (sessão do canal), não só pra essa pessoa.
        const channelSessionId = item.isGroup ? `wa-group-channel:${item.remoteJid}` : null;
        const channelHistoryMark = channelSessionId ? runtime.shortTerm?.mark?.(channelSessionId) ?? null : null;
        const prevR = reactionStateByUser.get(item.userId) ?? {
          messagesSinceLastReaction: 10,
          lastReactionAt: 0
        };
        const reactionState = {
          messagesSinceLastReaction: (prevR.messagesSinceLastReaction ?? 0) + 1,
          lastReactionAt: prevR.lastReactionAt ?? 0
        };
        let replies = [];
        const shouldGenerate =
          item.closeDecision !== "silent" && item.closeDecision !== "react";
        let composingDuringGeneration = false;
        runtime.waPresence?.active?.();
        // Abriu a conversa pra responder: as mensagens ficam lidas (tique azul) — como gente.
        if (item.messageKey?.id && !item.messageKey.fromMe && typeof waSocket().readMessages === "function") {
          waSocket().readMessages([item.messageKey]).catch(() => {});
        }
        try {
        let timingPlan = null;
        const shouldRunPipeline =
          runtime.defaults.replyEnabled ||
          runtime.defaults.learningModeEnabled ||
          item.mainObserveOnly;
        if (shouldRunPipeline) {
          if (shouldGenerate && item.media && !item.tetosCommand) {
            const visPromise = item.mediaVisionPromise ?? item.media.visionPromise;
            if (visPromise) {
              await settleMediaVision(item, visionFlushTimeoutMs(item));
            }
            if (item.media) {
              item.message =
                formatMediaInputText({
                  text: item.caption || "",
                  media: item.media
                }) || item.message;
            }
          }
          if (shouldGenerate) {
            console.log(`${logPrefix} generating reply for ${item.userId}…`);
          }
          let lastError = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const genStart = Date.now();
              const out = await Promise.race([
                withGenerationSlot(() =>
                  handleIncomingMessage(runtime, {
                    message: item.message,
                    userId: item.userId,
                    sessionId: item.sessionId,
                    channelId: item.channelId,
                    isGroup: item.isGroup,
                    participants: item.participants,
                    isDirectMention: item.isDirectMention,
                    groupEngagementActive: item.groupEngagementActive ?? false,
                    groupAddressKind: item.groupAddressKind ?? null,
                    isReply: item.isReply,
                    isReplyToBot: item.isReplyToBot ?? false,
                    quotedMessage: item.quotedMessage,
                    quotedMessageId: item.quotedMessageId ?? null,
                    replyThreadContext: item.replyThreadContext ?? null,
                    messageKey: item.messageKey,
                    closeDecision: item.closeDecision,
                    media: item.media,
                    pushName: item.pushName ?? null,
                    participantId: item.participantId ?? null,
                    segmentSpeakers: item.segmentSpeakers ?? null,
                    segmentMultiSpeaker: item.segmentMultiSpeaker ?? false,
                    segmentParts: item.segmentParts ?? null,
                    groupCatchUp: item.groupCatchUp === true,
                    groupCatchUpSkipped: item.groupCatchUpSkipped ?? 0,
                    sleepCatchUp: item.sleepCatchUp === true,
                    deferredCatchUp: item.deferredCatchUp ?? null,
                    sleepCatchUpCount: item.sleepCatchUpCount ?? 0,
                    sleepDisturbedWake: item.sleepDisturbedWake === true,
                    sleepTemporarilyAwake: item.sleepTemporarilyAwake === true,
                    tempWakeGrogginess: item.tempWakeGrogginess ?? 0,
                    tempWakeExtensionCount: item.tempWakeExtensionCount ?? 0,
                    sleepGroggy: item.sleepGroggy === true,
                    batchedCount: item.batchedCount ?? 1,
                    isOwner: item.isOwner ?? false,
                    mainObserveOnly: item.mainObserveOnly === true,
                    tetosCommand: item.tetosCommand === true,
                    onGenerationStart: async () => {
                      if (typeof waSocket().sendPresenceUpdate !== "function") return;
                      composingDuringGeneration = true;
                      // Presença é opcional: socket caindo no meio não pode derrubar a geração.
                      try {
                        await waSocket().sendPresenceUpdate("composing", item.remoteJid);
                      } catch (e) {
                        console.warn(`${logPrefix} composing (generation start) failed: ${e.message}`);
                      }
                    }
                  })
                ),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("model timeout")), timingCfg.modelTimeoutMs)
                )
              ]);

              replies = out?.replies ?? [];
              item.groupRoster = out?.groupRoster ?? null;
              if (replies.length > 0) {
                console.log(
                  `${logPrefix} reply ${replies.length} bolha(s) → ${replies.map((r) => JSON.stringify(String(r ?? "").slice(0, 140))).join(" | ")}`
                );
              }
              timingPlan = out?.timingPlan ?? null;
              const thinkMs = thinkDelaySleepMs({ ...item, timingPlan });
              const targetLatency =
                (timingPlan?.readDelayMs ?? 0) +
                (shouldSkipThinkDelaySleep({ ...item, timingPlan }) ? 0 : thinkMs);
              let remaining = Math.max(0, targetLatency - (Date.now() - genStart));
              if (item.groupCatchUp && remaining > 0) {
                remaining = Math.min(remaining, item.isGroup ? 500 : 800);
              }
              if (item.sleepCatchUp && remaining > 0) {
                remaining = Math.min(remaining, 600);
              }
              if (item.isGroup && (queueByGroupChannel.get(item.remoteJid)?.length ?? 0) > 0) {
                remaining = Math.min(remaining, 350);
              }
              if (remaining > 0 && replies.length > 0) {
                await sleep(remaining);
              }
              if (shouldDropGroupQueueItem(item, groupEpoch, activation)) {
                abortGroupTurn("group_deactivated_post_gen");
                return;
              }
              item.passiveMode = out?.policy?.mode ?? RESPONSE_MODES.FULL;
              addDecisionStep(item.decisionTrace, "pipeline.completed", {
                mode: item.passiveMode,
                replyCount: replies.length
              });
              if (item.passiveMode === RESPONSE_MODES.REACT_ONLY) {
                const reactActions = Array.isArray(replies.actions)
                  ? replies.actions.filter((a) => a.type === "react")
                  : [];
                if (reactActions.length) {
                  replies = [];
                  replies.actions = reactActions;
                } else {
                  replies = [];
                }
              }
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (error.message === "model timeout" && attempt === 0) {
                console.warn(`${logPrefix} model timeout, retrying for ${item.userId}…`);
                await sleep(400);
                continue;
              }
              if (/empty response/i.test(error.message) && attempt === 0) {
                console.warn(`${logPrefix} LLM resposta vazia, retrying for ${item.userId}…`);
                await sleep(600);
                continue;
              }
              console.error(`${logPrefix} generation error for ${item.userId}:`, error.message);
              replies = [];
              break;
            }
          }
          if (lastError?.message === "model timeout") {
            runtime.logger?.log?.("whatsapp.model_timeout", { userId: item.userId, sessionId: item.sessionId });
          }
          if ((!replies || replies.length === 0) && lastError) {
            console.error(`${logPrefix} critical failure in generation, triggering fallback error...\n`);
            try {
              const fallbackRaw = await runtime.agent.respond(
                item.message,
                {
                  userId: item.userId,
                  sessionId: item.sessionId,
                  fallback: "error",
                  errorMsg: lastError.message,
                  skipUserRecord: true
                },
                null,
                "calm"
              );
              if (fallbackRaw && !/^\[SEM_RESPOSTA\]/i.test(String(fallbackRaw).trim())) {
                replies = [fallbackRaw.trim()];
                replies.actions = [{ type: "message", text: replies[0], quoteId: null }];
              }
            } catch (fallbackError) {
              console.error(`${logPrefix} fallback LLM query failed:`, fallbackError.message);
            }

            if (!replies || replies.length === 0) {
              const fallbackText = `Alguem fala pra gabbis to com o probleminha "${lastError.message || "ERRO"}"`;
              replies = [fallbackText];
              replies.actions = [{ type: "message", text: fallbackText, quoteId: null }];
            }
          }
        } else {
          replies = [];
          item.passiveMode = RESPONSE_MODES.LEARN_ONLY;
          logThinking(runtime, {
            phase: "observe_only",
            userId: item.userId,
            remoteJid: item.remoteJid,
            detail: `closeDecision=${item.closeDecision} media=${item.media?.type ?? "none"}`
          });
          runtime.logger?.log?.("learning.observe_only_skipped", {
            userId: item.userId,
            channelId: item.channelId
          });
        }

        const hasOutgoing =
          Array.isArray(replies) && replies.some((r) => String(r ?? "").trim().length > 0);
        if (!hasOutgoing && shouldRunPipeline && allowReply) {
          console.warn(
            `${logPrefix} empty reply for ${item.userId} (close=${item.closeDecision} mode=${item.passiveMode ?? "?"} msg="${String(item.message ?? "").slice(0, 80)}")`
          );
        }
        if (hasOutgoing && !composingDuringGeneration && typeof waSocket().sendPresenceUpdate === "function") {
          try {
            await waSocket().sendPresenceUpdate("composing", item.remoteJid);
          } catch (e) {
            console.warn(`${logPrefix} composing (before send) failed: ${e.message}`);
          }
        }

        runtime.timeStore?.markSeen(item.userId, Date.now(), item.sessionId);
        runtime.userPatterns?.recordInteraction(item.userId);
        if (!hasOutgoing && typeof waSocket().sendPresenceUpdate === "function") {
          try {
            await waSocket().sendPresenceUpdate("paused", item.remoteJid);
          } catch (_) {
            /* ignore */
          }
        }
        if (interruptBySession.get(sessionId) !== token) {
          // Chegou msg nova antes de qualquer bolha sair: descarta esta resposta (e tira do histórico,
          // senão a Teto "lembra" de algo que nunca mandou) — o próximo turno responde tudo junto.
          runtime.shortTerm?.popSince?.(sessionId, historyMark);
          supersededBySession.set(sessionId, item);
          finalizeDecisionTrace(runtime, item.decisionTrace, {
            activation: "allowed",
            pipelineMode: item.passiveMode ?? RESPONSE_MODES.FULL,
            output: RESPONSE_OUTPUTS.IGNORED
          });
          return;
        }
        sendingBySession.add(sessionId);
        // Último filtro de estilo (anti-flood, CAPS, abertura repetida) — compara com o que ela mandou antes deste turno.
        // Sem marcador = histórico estava vazio no começo do turno (tudo que há agora é deste turno).
        const styleSession = channelSessionId ?? sessionId;
        const styleMark = channelSessionId ? channelHistoryMark : historyMark;
        const historyNow = runtime.shortTerm?.getAll?.(styleSession) ?? [];
        const markAt = styleMark ? historyNow.indexOf(styleMark) : -1;
        const styleCtx = {
          isGroup: Boolean(item.isGroup),
          maxParts: DEFAULTS.responseMaxParts,
          dropIfAllRepeated: Boolean(item.isGroup),
          recentTurns: recentAssistantTurns(markAt >= 0 ? historyNow.slice(0, markAt + 1) : [])
        };
        if (Array.isArray(replies) && !item.tetosCommand) {
          const actions = replies.actions;
          if (Array.isArray(actions) && actions.length) {
            const regulated = regulateMessageActions(resolveOutgoingActions(actions), styleCtx);
            replies = regulated.filter((a) => a.type === "message").map((a) => a.text);
            replies.actions = regulated;
          } else if (replies.length) {
            replies = regulateBubbles(replies, styleCtx).texts;
          }
        }
        if (shouldDropGroupQueueItem(item, groupEpoch, activation)) {
          abortGroupTurn("group_deactivated_pre_send");
          return;
        }
        let executedActions = false;
        let reactedThisTurn = false;
        let autoQuotedThisTurn = false;
        if (replies && Array.isArray(replies.actions) && replies.actions.length > 0 && allowReply) {
          executedActions = true;
          const softened = runtime.userPatterns
            ? !runtime.userPatterns.isLikelyActiveNow(item.userId)
            : false;
          const actionsToRun = resolveOutgoingActions(
            sanitizeOutgoingActions(replies.actions, buildSanitizeMeta(item))
          );
          const mediaActions = actionsToRun.filter(
            (a) =>
              a.type === "media" ||
              a.type === "toimage" ||
              a.type === "url_download" ||
              a.type === "generate_image"
          );
          const immediateActions = sortImmediateActions(
            actionsToRun.filter(
              (a) =>
                a.type !== "media" &&
                a.type !== "toimage" &&
                a.type !== "url_download" &&
                a.type !== "generate_image"
            )
          );
          console.log(
            `${logPrefix} action plan (${actionsToRun.length}): ${actionsToRun
              .map((a) => `${a.type}${a.command ? `:${a.command}` : ""}${a.key ? `:${a.key}` : ""}`)
              .join(", ")}`
          );
          const runAction = async (action, index) => {
            if (interruptBySession.get(sessionId) !== token) {
              console.warn(`${logPrefix} execution interrupted (token mismatch)`);
              return false;
            }
            if (index > 0) {
              await sleep(randBetween(800, 1500));
            }
            try {
              if (action.type === "react") {
                const reactionKey = buildOutgoingQuoteKey(item.messageKey, item.remoteJid, {
                  participantId: item.participantId ?? null,
                  participantJid: item.participantJid ?? item.messageKey?.participant ?? null
                });
                if (reactionKey && action.emoji) {
                  console.log(`${logPrefix} executing action reaction: ${action.emoji}`);
                  await waSocket().sendMessage(item.remoteJid, {
                    react: { text: action.emoji, key: reactionKey }
                  });
                  outputKind = RESPONSE_OUTPUTS.REACTION;
                  reactedThisTurn = true;
                }
              } else if (action.type === "voice") {
                // Mensagem de voz: "gravando áudio…" enquanto sintetiza, depois manda como áudio de zap.
                const requested = /(?<!\p{L})([aá]udio|voz|fala comigo|grava)(?!\p{L})/iu.test(String(item.message ?? ""));
                const voice = runtime.voiceNotes;
                if (!voice?.canSend(item.remoteJid, { requested }) || (item.isGroup && !requested)) {
                  if (action.text) await sendReplies(item.remoteJid, item.userId, item.sessionId, [action.text], token, { allowReply, groupRoster: item.groupRoster ?? null });
                } else {
                  try {
                    await waSocket().sendPresenceUpdate?.("recording", item.remoteJid);
                    const started = Date.now();
                    const note = await voice.synthesize(action.text);
                    const recordMs = Math.min(9000, note.seconds * 700) - (Date.now() - started);
                    if (recordMs > 0) await sleep(recordMs);
                    if (interruptBySession.get(sessionId) !== token) return false;
                    const quote = resolveActionQuoteKey(action.quoteId, item);
                    const quotedWa = resolveQuotedWaMessage(quote, item.remoteJid);
                    await waSocket().sendMessage(
                      item.remoteJid,
                      { audio: note.audio, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: note.seconds },
                      quotedWa ? { quoted: quotedWa } : undefined
                    );
                    await waSocket().sendPresenceUpdate?.("paused", item.remoteJid);
                    voice.markSent(item.remoteJid);
                    outputKind = RESPONSE_OUTPUTS.TEXT;
                    runtime.metrics?.increment?.("whatsapp.voice.sent");
                    console.log(`${logPrefix} áudio de voz enviado (${note.seconds}s): ${note.spoken.slice(0, 80)}`);
                  } catch (error) {
                    console.warn(`${logPrefix} áudio de voz falhou, mandando texto: ${error?.message ?? error}`);
                    await sendReplies(item.remoteJid, item.userId, item.sessionId, [action.text], token, { allowReply, groupRoster: item.groupRoster ?? null });
                  }
                }
              } else if (action.type === "sticker") {
                const stickerAsset = resolveStickerAsset(action.key, runtime.defaults.stickersPath);
                if (stickerAsset) {
                  console.log(`${logPrefix} executing action sticker: ${action.key}`);
                  const quote = resolveActionQuoteKey(action.quoteId, item);
                  const indexedRow =
                    quote?.id && chatMessageIndex
                      ? chatMessageIndex.get(item.remoteJid, quote.id)
                      : null;
                  const quotedWa = resolveQuotedWaMessage(quote, item.remoteJid);
                  const payload = quotedWa
                    ? { sticker: stickerAsset }
                    : applyQuotedContextToPayload({ sticker: stickerAsset }, quote, indexedRow);
                  await waSocket().sendMessage(
                    item.remoteJid,
                    payload,
                    quotedWa ? { quoted: quotedWa } : undefined
                  );
                  outputKind = RESPONSE_OUTPUTS.STICKER;
                  runtime.metrics?.increment?.("whatsapp.sticker.sent");
                }
              } else if (action.type === "save_sticker") {
                const targetId =
                  chatMessageIndex?.resolveQuoteMessageId?.(item.remoteJid, action.messageId) ??
                  action.messageId;
                const resolved = await resolveMediaByMessageId({
                  messageId: targetId,
                  chatId: item.remoteJid,
                  mediaHistoryStore,
                  basePath: runtime.defaults.whatsappMediaPath,
                  visualAnalyses: runtime.visualAnalyses,
                  getWaMessageById,
                  triggerMessageId: item.messageKey?.id ?? null,
                  downloadContentFromMessage
                });
                if (resolved?.media?.type !== "sticker" || !resolved.media.path) {
                  await sendReplies(
                    item.remoteJid,
                    item.userId,
                    item.sessionId,
                    ["so consigo salvar figurinha — manda o message id de uma sticker"],
                    token,
                    { allowReply, groupRoster: item.groupRoster ?? null }
                  );
                  outputKind = RESPONSE_OUTPUTS.TEXT;
                } else {
                  const userKeyProvided = Boolean(String(action.key ?? "").trim());
                  const saved = await saveStickerToRepertoireWithVision({
                    runtime,
                    sourcePath: resolved.media.path,
                    basePath: runtime.defaults.stickersPath,
                    key: action.key,
                    messageId: targetId,
                    savedFrom: item.remoteJid,
                    label: action.label,
                    media: resolved.media,
                    userId: item.userId,
                    remoteJid: item.remoteJid,
                    skipVision: userKeyProvided
                  });
                  if (!runtime.repertoireHandledMessageIds) {
                    runtime.repertoireHandledMessageIds = new Map();
                  }
                  runtime.repertoireHandledMessageIds.set(targetId, Date.now());
                  logRepertoireVision(runtime, "manual_save_ok", {
                    key: saved.key,
                    messageId: targetId,
                    displayName: saved.displayName ?? null,
                    visionSource: saved.visionSource ?? null,
                    autoNamed: saved.autoNamed ?? false,
                    hadMediaTranscript: Boolean(resolved.media?.transcript)
                  });
                  console.log(
                    `${logPrefix} saved sticker to repertoire: ${saved.key} (${saved.path})${saved.displayName ? ` — ${saved.displayName}` : ""}`
                  );
                  runtime.logger?.log?.("whatsapp.sticker_repertoire_saved", {
                    key: saved.key,
                    messageId: targetId,
                    remoteJid: item.remoteJid,
                    displayName: saved.displayName ?? null,
                    autoNamed: saved.autoNamed ?? false
                  });
                  // A Teto já confirmou do jeito dela? Então não repete com texto de sistema.
                  const alreadyConfirmed = actionsToRun.some((a) => a.type === "message" && String(a.text ?? "").trim());
                  const saveLabel = String(saved.key ?? "").replace(/[-_]+/g, " ").trim() || "figurinha nova";
                  const quoteKeyForSave = buildQuoteKeyFromMessageId(
                    chatMessageIndex,
                    item.remoteJid,
                    targetId,
                    {
                      participantId: item.participantId ?? null,
                      participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                      getWaMessageById,
                      groupMemory: runtime.groupMemory
                    }
                  );
                  if (!alreadyConfirmed) await sendReplies(
                    item.remoteJid,
                    item.userId,
                    item.sessionId,
                    [`salvei como "${saveLabel}" kkk`],
                    token,
                    {
                      allowReply,
                      groupRoster: item.groupRoster ?? null,
                      participantId: item.participantId ?? null,
                      participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                      quoteMessageKey: quoteKeyForSave
                    }
                  );
                  outputKind = RESPONSE_OUTPUTS.COMMAND;
                }
              } else if (action.type === "repertoire_mode") {
                const store = runtime.stickerRepertoireMode;
                if (store) {
                  if (action.enabled) {
                    store.enable(item.userId, {
                      channelId: item.remoteJid,
                      enabledBy: item.userId
                    });
                    console.log(`${logPrefix} repertoire mode ON for ${item.userId}`);
                  } else {
                    store.disable(item.userId);
                    console.log(`${logPrefix} repertoire mode OFF for ${item.userId}`);
                  }
                }
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "silence") {
                const eng = runtime.groupEngagement;
                if (eng?.muteFromAgent) {
                  const applied = eng.muteFromAgent(item.remoteJid, item.userId, {
                    scope: action.scope,
                    ttlMs: runtime.defaults.groupMuteMs
                  });
                  console.log(
                    `${logPrefix} calar scope=${applied?.scope ?? "channel"} until=${applied?.expiresAt ?? "?"}`
                  );
                }
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "automate") {
                // PC da dona pelo zap: só no PV dela, via API (que fala com o AutoMate). Resultado volta pela caixa de saída.
                const bridge = runtime.automateBridge;
                const canUse = bridge?.enabled && item.isOwner && !item.isGroup && action.intent;
                const outcome = canUse ? await bridge.run(action.intent, item.remoteJid) : { ok: false, reason: "not_owner" };
                const notice = outcome.ok
                  ? null
                  : outcome.reason === "offline"
                    ? "teu pc tá sem o AutoMate aberto agora 😔 abre ele que eu faço"
                    : outcome.reason === "not_owner"
                      ? "daqui eu não consigo mexer em computador nenhum 😅"
                      : "tentei falar com teu pc mas não rolou agora, tenta pelo app?";
                console.log(`${logPrefix} automate pelo zap: ${outcome.ok ? `enfileirado (${outcome.runId})` : outcome.reason}`);
                if (notice) {
                  await sendReplies(item.remoteJid, item.userId, item.sessionId, [notice], token, {
                    softened,
                    timingPlan,
                    allowReply,
                    groupRoster: item.groupRoster ?? null
                  });
                }
              } else if (action.type === "url_download") {
                console.log(
                  `${logPrefix} executing url_download ${action.command}: ${action.url}`
                );
                const urlRun = mediaCommands().runUrlDownloadCommand({
                  command: action.command,
                  url: action.url,
                  args: action.args ?? [],
                  remoteJid: item.remoteJid,
                  userId: item.userId
                });
                urlRun.catch((err) => {
                  console.error(
                    `${logPrefix} url download failed (${action.command}):`,
                    err?.message ?? err
                  );
                });
                void urlRun;
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "media" || action.type === "toimage") {
                const command = action.command ?? "toimg";
                const targetId =
                  chatMessageIndex?.resolveQuoteMessageId?.(item.remoteJid, action.messageId) ??
                  action.messageId;
                const resolved = await resolveMediaByMessageId({
                  messageId: targetId,
                  chatId: item.remoteJid,
                  mediaHistoryStore,
                  basePath: runtime.defaults.whatsappMediaPath,
                  visualAnalyses: runtime.visualAnalyses,
                  getWaMessageById,
                  triggerMessageId: item.messageKey?.id ?? null,
                  downloadContentFromMessage
                });
                console.log(
                  `${logPrefix} executing action ${command}: ${targetId} (source=${resolved?.source ?? "none"})`
                );
                const mediaRun = mediaCommands().runAgentMediaCommand({
                  command,
                  messageId: targetId,
                  args: action.args ?? [],
                  media: resolved?.media ?? null,
                  remoteJid: item.remoteJid,
                  userId: item.userId,
                  targetSource: resolved?.source ?? "agent"
                });
                mediaRun.catch((err) => {
                  console.error(`${logPrefix} agent media command failed (${command}):`, err?.message ?? err);
                });
                void mediaRun;
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "generate_image") {
                const result = await runtime.imageGenerationService?.generate?.({
                  prompt: action.prompt,
                  userId: item.userId
                });
                if (result?.ok && result.buffer) {
                  await sendRaw(item.remoteJid, { image: result.buffer });
                  if (action.caption) {
                    await sendReplies(
                      item.remoteJid,
                      item.userId,
                      item.sessionId,
                      [action.caption],
                      token,
                      { softened, timingPlan, allowReply, groupRoster: item.groupRoster ?? null }
                    );
                  }
                  outputKind = RESPONSE_OUTPUTS.COMMAND;
                } else if (result?.error) {
                  await sendReplies(
                    item.remoteJid,
                    item.userId,
                    item.sessionId,
                    [`não consegui gerar a imagem: ${result.error}`],
                    token,
                    { softened, timingPlan, allowReply, groupRoster: item.groupRoster ?? null }
                  );
                }
              } else if (action.type === "message") {
                console.log(`${logPrefix} executing action message: ${action.text} (quoteId: ${action.quoteId})`);
                const explicitQuote = action.quoteId ?? null;
                const autoQuoteId = item.tetosCommand
                  ? null
                  : explicitQuote ??
                    (autoQuotedThisTurn ? null : resolveOutgoingQuoteId(item));
                if (!explicitQuote && autoQuoteId) {
                  autoQuotedThisTurn = true;
                }
                const quoteKey = resolveActionQuoteKey(autoQuoteId, item);
                await sendReplies(item.remoteJid, item.userId, item.sessionId, [action.text], token, {
                  softened,
                  timingPlan,
                  allowReply,
                  groupRoster: item.groupRoster ?? null,
                  participantId: item.participantId ?? null,
                  participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                  quoteMessageKey: quoteKey,
                  tetosCommand: item.tetosCommand === true
                });
                outputKind = RESPONSE_OUTPUTS.TEXT;
              }
            } catch (actionError) {
              console.error(`${logPrefix} failed to execute action ${action.type}:`, actionError.message);
            }
            return true;
          };
          for (let index = 0; index < immediateActions.length; index += 1) {
            const done = await runAction(immediateActions[index], index);
            if (done === false) break;
          }
          for (let index = 0; index < mediaActions.length; index += 1) {
            const done = await runAction(
              mediaActions[index],
              immediateActions.length > 0 ? index + 1 : index
            );
            if (done === false) break;
          }
        }

        const tryPassiveReaction = async () => {
          if (!allowReply || reactedThisTurn) return false;
          const passiveAction = resolvePassiveModeAction({
            policy: { allowed: true, mode: item.passiveMode },
            media: item.media,
            isGroup: item.isGroup
          });
          const affinities =
            runtime.brainOrchestrator?.mediaHub?.getAffinities?.({
              userId: item.userId,
              channelId: item.channelId ?? item.remoteJid,
              isGroup: item.isGroup
            }) ?? null;
          const plan = planWhatsAppReaction({
            userText: item.message,
            state: reactionState,
            affinities
          });
          const forcedReaction =
            item.closeDecision === "react" || passiveAction.type === RESPONSE_MODES.REACT_ONLY
              ? "❤️"
              : null;
          const emoji = plan.emoji ?? forcedReaction;
          const reactionKey = buildOutgoingQuoteKey(item.messageKey, item.remoteJid, {
            participantId: item.participantId ?? null,
            participantJid: item.participantJid ?? item.messageKey?.participant ?? null
          });
          if (!emoji || !reactionKey || typeof waSocket().sendMessage !== "function") {
            reactionStateByUser.set(item.userId, {
              messagesSinceLastReaction: reactionState.messagesSinceLastReaction,
              lastReactionAt: reactionState.lastReactionAt
            });
            return false;
          }
          try {
            await waSocket().sendMessage(item.remoteJid, {
              react: { text: emoji, key: reactionKey }
            });
            outputKind = RESPONSE_OUTPUTS.REACTION;
            reactedThisTurn = true;
            reactionStateByUser.set(item.userId, {
              messagesSinceLastReaction: 0,
              lastReactionAt: Date.now()
            });
            return true;
          } catch (e) {
            console.warn(`[whatsapp] reaction failed: ${e.message}`);
            reactionStateByUser.set(item.userId, {
              ...reactionState,
              lastReactionAt: reactionState.lastReactionAt
            });
            return false;
          }
        };

        if (executedActions) {
          await tryPassiveReaction();
        }

        if (!executedActions) {
        const passiveAction = resolvePassiveModeAction({
          policy: { allowed: true, mode: item.passiveMode },
          media: item.media,
          isGroup: item.isGroup
        });

        const affinities =
          runtime.brainOrchestrator?.mediaHub?.getAffinities?.({
            userId: item.userId,
            channelId: item.channelId ?? item.remoteJid,
            isGroup: item.isGroup
          }) ?? null;
        const plan = planWhatsAppReaction({
          userText: item.message,
          state: reactionState,
          affinities
        });
        const forcedReaction = item.closeDecision === "react" || passiveAction.type === RESPONSE_MODES.REACT_ONLY ? "❤️" : null;
        const emoji = plan.emoji ?? forcedReaction;
        const reactionKey = buildOutgoingQuoteKey(item.messageKey, item.remoteJid, {
          participantId: item.participantId ?? null,
          participantJid: item.participantJid ?? item.messageKey?.participant ?? null
        });
        const reacted = Boolean(emoji && reactionKey && typeof waSocket().sendMessage === "function");
        if (reacted && allowReply) {
          try {
            await waSocket().sendMessage(item.remoteJid, {
              react: { text: emoji, key: reactionKey }
            });
            outputKind = RESPONSE_OUTPUTS.REACTION;
            reactionStateByUser.set(item.userId, {
              messagesSinceLastReaction: 0,
              lastReactionAt: Date.now()
            });
          } catch (e) {
            console.warn(`[whatsapp] reaction failed: ${e.message}`);
            reactionStateByUser.set(item.userId, {
              ...reactionState,
              lastReactionAt: reactionState.lastReactionAt
            });
          }
        } else {
          reactionStateByUser.set(item.userId, {
            messagesSinceLastReaction: reactionState.messagesSinceLastReaction,
            lastReactionAt: reactionState.lastReactionAt
          });
        }
        const softened = runtime.userPatterns
          ? !runtime.userPatterns.isLikelyActiveNow(item.userId)
          : false;
        if (!reacted && passiveAction.type === RESPONSE_MODES.STICKER_ONLY && allowReply) {
          const stickerAsset = resolveStickerAsset(passiveAction.stickerKey, runtime.defaults.stickersPath);
          if (stickerAsset) {
            try {
              await waSocket().sendMessage(item.remoteJid, { sticker: stickerAsset });
              outputKind = RESPONSE_OUTPUTS.STICKER;
              runtime.metrics?.increment?.("whatsapp.sticker.sent");
              runtime.logger?.log?.("whatsapp.sticker_sent", {
                remoteJid: item.remoteJid,
                stickerKey: stickerAsset.key
              });
            } catch (error) {
              runtime.logger?.log?.("whatsapp.sticker_error", {
                remoteJid: item.remoteJid,
                error: error.message
              });
            }
          } else {
            runtime.metrics?.increment?.("whatsapp.sticker.missing_asset");
            runtime.logger?.log?.("whatsapp.sticker_missing_asset", {
              remoteJid: item.remoteJid,
              stickerKey: passiveAction.stickerKey
            });
          }
        }

        if (!reacted && allowReply) {
          const hasOutgoing =
            Array.isArray(replies) && replies.some((r) => String(r ?? "").trim().length > 0);
          if (hasOutgoing) {
            // A pessoa voltou a digitar? Espera ela terminar (como gente) — às vezes atropela de leve.
            const typingNow = () => typing.isTyping(item.remoteJid, item.isGroup ? item.participantJid : null);
            if (typingNow() && Math.random() >= 0.12) {
              const waitStarted = Date.now();
              while (typingNow() && Date.now() - waitStarted < PRE_SEND_TYPING_WAIT_MS) {
                await sleep(500);
              }
            }
            const debounceMs = randBetween(timingCfg.interruptDebounceMinMs, timingCfg.interruptDebounceMaxMs);
            await sleep(debounceMs);
          }
          const quoteTargetId = item.tetosCommand ? null : resolveOutgoingQuoteId(item);
          const quoteKeyForSend =
            !item.tetosCommand && quoteTargetId
              ? buildQuoteKeyFromMessageId(chatMessageIndex, item.remoteJid, quoteTargetId, {
                  participantId: item.participantId ?? null,
                  participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                  getWaMessageById,
                  groupMemory: runtime.groupMemory
                })
              : null;
          const shouldQuote = Boolean(quoteKeyForSend);
          const quoteKeys = Array.isArray(item.quoteMessageKeys)
            ? item.quoteMessageKeys
            : shouldQuote
              ? replies.map((_, i) => (i === 0 ? quoteKeyForSend : item.quoteMessageKeys?.[i] ?? null))
              : [];
          const bubbleProcessor = runtime.chatService?.getProcessor?.({ sessionId: item.sessionId });
          const bubbleDelays = bubbleProcessor?.lastBubblePlan?.delays ?? null;
          await sendReplies(item.remoteJid, item.userId, item.sessionId, replies, token, {
            softened,
            timingPlan,
            bubbleDelays,
            allowReply,
            groupRoster: item.groupRoster ?? null,
            participantId: item.participantId ?? null,
            participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
            quoteMessageKey: shouldQuote ? quoteKeyForSend : null,
            quoteMessageKeys: quoteKeys.filter(Boolean).length ? quoteKeys : undefined,
            tetosCommand: item.tetosCommand === true,
            batchedCount: item.batchedCount ?? 1,
            sleepGroggy: Boolean(item.sleepGroggy || timingPlan?.typingProfile === "drowsy"),
            sleepTemporarilyAwake: Boolean(item.sleepTemporarilyAwake)
          });
          if (hasOutgoing) {
            outputKind = RESPONSE_OUTPUTS.TEXT;
          }
        }
        }
        finalizeDecisionTrace(runtime, item.decisionTrace, {
          activation: "allowed",
          pipelineMode: item.passiveMode ?? RESPONSE_MODES.FULL,
          output: outputKind
        });
        } finally {
          if (
            item.isGroup &&
            item.remoteJid &&
            currentSessionByGroupChannel.get(item.remoteJid) === sessionId
          ) {
            currentSessionByGroupChannel.delete(item.remoteJid);
          }
          if (composingDuringGeneration && typeof waSocket().sendPresenceUpdate === "function") {
            try {
              await waSocket().sendPresenceUpdate("paused", item.remoteJid);
            } catch (_) {
              /* ignore */
            }
          }
        }
  }

  async function drainSessionQueue(sessionId) {
    if (runningBySession.has(sessionId)) return;
    runningBySession.add(sessionId);
    try {
      while (queueBySession.get(sessionId)?.length) {
        const item = queueBySession.get(sessionId).shift();
        if (!item) continue;
        await processQueueItem(item);
      }
    } finally {
      runningBySession.delete(sessionId);
      sendingBySession.delete(sessionId);
      flushDeferredSession(sessionId);
    }
  }

  async function drainGroupChannel(channelKey) {
    if (runningByGroupChannel.has(channelKey)) return;
    runningByGroupChannel.add(channelKey);
    try {
      while (queueByGroupChannel.get(channelKey)?.length) {
        const { item, rest } = takeNextGroupTurn(queueByGroupChannel.get(channelKey));
        queueByGroupChannel.set(channelKey, rest);
        if (!item) continue;
        await processQueueItem(item);
        if (queueByGroupChannel.get(channelKey)?.length) {
          await sleep(randBetween(timingCfg.interruptDebounceMinMs, timingCfg.interruptDebounceMaxMs + 500));
        }
      }
    } finally {
      runningByGroupChannel.delete(channelKey);
    }
  }

  function enqueueGroupSegment(entry) {
    const channelKey = entry.remoteJid;
    const priority = isGroupPriorityEntry(entry);
    if (runningByGroupChannel.has(channelKey) && priority && !entry.tetosCommand) {
      bumpInterrupt(entry.sessionId ?? entry.userId);
    }
    let queue = queueByGroupChannel.get(channelKey) ?? [];
    if (priority) {
      // Prioridade passa na frente das normais, mas entre si mantém a ordem de chegada.
      const firstNormal = queue.findIndex((q) => !isGroupPriorityEntry(q));
      queue.splice(firstNormal < 0 ? queue.length : firstNormal, 0, entry);
    } else {
      queue.push(entry);
    }
    const before = queue.length;
    queue = compactGroupQueueSegments(queue);
    if (queue.length < before) {
      console.log(
        `[whatsapp] fila grupo compactada ${before}→${queue.length} (${channelKey})`
      );
    }
    queueByGroupChannel.set(channelKey, queue);
    drainGroupChannel(channelKey).catch((error) => {
      console.error("[whatsapp] group channel queue error:", error.message);
    });
  }

  function processCollectedGroupEntries(channelKey, collected = []) {
    if (!collected.length) return;
    const floodPlan = planFloodAwareGroupSegments(collected);
    const segments = floodPlan.segments;
    if (floodPlan.mode === "catchup" && floodPlan.droppedCount > 0) {
      console.log(
        `[whatsapp] grupo rajada: ${collected.length} msgs — absorveu ${floodPlan.droppedCount}, responde só ao recente (${channelKey})`
      );
    }
    segments.sort(
      (a, b) => Number(Boolean(b.groupPriorityAddress)) - Number(Boolean(a.groupPriorityAddress))
    );
    if (segments.length > 1) {
      console.log(
        `[whatsapp] grupo ${collected.length} msgs → ${segments.length} resposta(s) com quote (${channelKey})`
      );
    } else if ((segments[0]?.batchedCount ?? 1) > 1) {
      console.log(
        `[whatsapp] grupo batch ${segments[0].batchedCount} msgs → 1 resposta (${channelKey})`
      );
    }
    for (const seg of segments) {
      enqueueGroupSegment(seg);
    }
  }

  function scheduleGroupIncoming(entry) {
    const channelKey = entry.remoteJid;
    const priority = isGroupPriorityEntry(entry);
    const normalized = { ...entry, ts: entry.ts ?? Date.now(), groupPriorityAddress: priority };
    if (isMediaHoldEntry(normalized) && !normalized.mediaHoldStartedAt) {
      normalized.mediaHoldStartedAt = Date.now();
    }

    let pending = pendingByGroupChannel.get(channelKey) ?? { entries: [], timer: null };

    if (pending.timer) clearTimeout(pending.timer);

    if (priority && pending.entries.some((e) => !isGroupPriorityEntry(e))) {
      const nonPriority = pending.entries.filter((e) => !isGroupPriorityEntry(e));
      const keepPriority = pending.entries.filter((e) => isGroupPriorityEntry(e));
      if (nonPriority.length) {
        processCollectedGroupEntries(channelKey, nonPriority);
      }
      pending.entries = keepPriority;
    }

    pending.entries.push(normalized);

    pending.startedAt ??= Date.now();
    const stillTyping = pending.entries.some((e) => typing.isTyping(e.remoteJid, e.participantJid));
    const hasPriority = pending.entries.some(isGroupPriorityEntry);
    const holdSeed = pending.entries.find(isMediaHoldEntry) ?? null;
    const last = pending.entries[pending.entries.length - 1];
    // Chamada direta: janela curta (como no PV) pra pegar quem chamou junto — e não responder em 0,4s.
    const baseBatch = hasPriority
      ? Math.min(2600, Math.max(1200, textSettleMs(last?.message ?? "")))
      : timingCfg.groupBatchWindowMs;
    let batchMs = stillTyping
      ? Math.min(hasPriority ? 2800 : 6500, Math.round(baseBatch * (hasPriority ? 1.6 : 2.4)))
      : baseBatch;
    if (holdSeed && hasPriority) {
      batchMs = computeDirectBatchMs(last, holdSeed, {
        stillTyping,
        batchWindowMs: timingCfg.groupBatchWindowMs,
        mediaHoldMs: timingCfg.mediaHoldMs
      });
    }

    const fire = () => {
      // Ainda tem alguém da rajada digitando? Reconfere em vez de responder pela metade.
      const typingStill = pending.entries.some((e) => typing.isTyping(e.remoteJid, e.participantJid));
      if (typingStill && Date.now() - pending.startedAt < GROUP_BURST_MAX_MS) {
        pending.timer = setTimeout(fire, TYPING_RECHECK_MS);
        return;
      }
      const collected = pending.entries;
      pendingByGroupChannel.delete(channelKey);
      processCollectedGroupEntries(channelKey, collected);
    };
    pending.timer = setTimeout(fire, batchMs);

    pendingByGroupChannel.set(channelKey, pending);
  }

  function coalesceQueueEntries(entries = []) {
    if (entries.length <= 1) return entries;
    const first = entries[0];
    const merged = entries.slice(1).reduce(
      (acc, cur) => ({
        ...acc,
        message: `${acc.message}\n${cur.message}`.trim(),
        caption: [acc.caption, cur.caption].map((c) => String(c ?? "").trim()).filter(Boolean).join("\n") || acc.caption,
        messageKey: cur.messageKey ?? acc.messageKey,
        media: cur.media ?? acc.media,
        mediaVisionPromise: cur.mediaVisionPromise ?? acc.mediaVisionPromise,
        mediaHoldStartedAt: stampMediaHoldStart(acc, cur),
        quotedMessage: cur.quotedMessage ?? acc.quotedMessage,
        quotedMessageId: cur.quotedMessageId ?? acc.quotedMessageId,
        replyThreadContext: cur.replyThreadContext ?? acc.replyThreadContext,
        isReply: cur.isReply || acc.isReply,
        isReplyToBot: cur.isReplyToBot || acc.isReplyToBot,
        isDirectMention: cur.isDirectMention || acc.isDirectMention,
        groupEngagementActive: cur.groupEngagementActive || acc.groupEngagementActive,
        groupPriorityAddress: cur.groupPriorityAddress || acc.groupPriorityAddress,
        groupAddressKind: cur.groupAddressKind ?? acc.groupAddressKind,
        batchedCount: (acc.batchedCount ?? 1) + (cur.batchedCount ?? 1),
        pushName: cur.pushName ?? acc.pushName
      }),
      { ...first, batchedCount: first.batchedCount ?? 1 }
    );
    return [merged];
  }

  function enqueue(entry) {
    const key = entry.sessionId ?? entry.userId;
    let queue = queueBySession.get(key) ?? [];
    const maxCoalesce = Number(runtime.defaults.maxQueueCoalesce ?? 6);

    if (runningBySession.has(key) && shouldBumpInterruptOnEnqueue(entry)) {
      bumpInterrupt(key);
    }

    const last = queue[queue.length - 1];
    const mergedWithLast = last ? mergeDirectEntries(last, entry) : null;
    if (mergedWithLast && queue.length < maxCoalesce) {
      queue[queue.length - 1] = mergedWithLast;
    } else if (queue.length >= maxCoalesce - 1) {
      queue = coalesceQueueEntries([...queue, entry]);
      console.warn(`[whatsapp] fila ${key} cheia — ${maxCoalesce} msgs fundidas em 1 resposta`);
    } else {
      queue.push(entry);
    }

    queueBySession.set(key, queue);
    drainSessionQueue(key).catch((error) => {
      console.error("[whatsapp] queue processing error:", error.message);
    });
  }

  function stampIncomingHold(entry) {
    if (isMediaHoldEntry(entry) && !entry.mediaHoldStartedAt) {
      return { ...entry, mediaHoldStartedAt: Date.now(), batchedCount: entry.batchedCount ?? 1 };
    }
    return { ...entry, batchedCount: entry.batchedCount ?? 1 };
  }

  function armDirectPending(key, merged) {
    merged.burstStartedAt ??= Date.now();
    const stillTyping = typing.isTyping(merged.remoteJid);
    const batchMs = computeDirectBatchMs(merged, merged, {
      stillTyping,
      batchWindowMs: merged.isGroup ? timingCfg.groupBatchWindowMs : timingCfg.batchWindowMs,
      mediaHoldMs: timingCfg.mediaHoldMs
    });
    const timer = setTimeout(() => {
      // Digitando de novo (continuação)? Espera mais, até o teto da rajada.
      if (typing.isTyping(merged.remoteJid) && Date.now() - merged.burstStartedAt < DM_BURST_MAX_MS) {
        const next = { ...merged };
        delete next.timer;
        armDirectPending(key, next);
        return;
      }
      pendingBySession.delete(key);
      if (merged.batchedCount > 1) {
        console.log(`[whatsapp] batch ${merged.batchedCount} msgs → 1 reply (${key})`);
      }
      const flushed = { ...merged };
      delete flushed.timer;
      enqueue(flushed);
    }, batchMs);
    pendingBySession.set(key, { ...merged, timer });
  }

  function scheduleDirectIncoming(entry) {
    const key = entry.sessionId ?? entry.userId;
    const incoming = stampIncomingHold(entry);

    if (runningBySession.has(key)) {
      // Ainda gerando (nenhuma bolha saiu)? Interrompe: o próximo turno lê esta msg junto com as anteriores.
      if (!sendingBySession.has(key) && shouldBumpInterruptOnEnqueue(incoming)) bumpInterrupt(key);
      const prev = deferredBySession.get(key);
      if (prev && shouldSplitBurst(prev, incoming)) {
        enqueue({ ...prev });
        deferredBySession.set(key, incoming);
        return;
      }
      const merged = prev ? mergeDirectEntries(prev, incoming) : incoming;
      if (merged) {
        deferredBySession.set(key, merged);
      } else {
        if (prev) enqueue({ ...prev });
        deferredBySession.set(key, incoming);
      }
      return;
    }

    let previous = pendingBySession.get(key);

    if (previous?.timer && (shouldFlushPendingOnIncoming(previous, incoming) || shouldSplitBurst(previous, incoming))) {
      clearTimeout(previous.timer);
      const flushed = { ...previous };
      delete flushed.timer;
      pendingBySession.delete(key);
      enqueue(flushed);
      previous = null;
    }

    if (previous?.timer) clearTimeout(previous.timer);
    const merged = previous
      ? mergeDirectEntries(previous, incoming) ?? incoming
      : incoming;

    armDirectPending(key, merged);
  }

  /** Pessoa parou de digitar: se a rajada parece completa, responde logo em vez de esperar o tempo cheio. */
  function shortenPendingForChat(chatJid) {
    for (const [key, pending] of pendingBySession.entries()) {
      if (pending.remoteJid !== chatJid || !pending.timer) continue;
      if (textSettleMs(pending.message ?? "") > 2600) continue; // termina pendurada — deve vir mais
      clearTimeout(pending.timer);
      const next = { ...pending };
      delete next.timer;
      const timer = setTimeout(() => {
        pendingBySession.delete(key);
        const flushed = { ...next };
        enqueue(flushed);
      }, 900);
      pendingBySession.set(key, { ...next, timer });
    }
  }

  function scheduleIncoming(entry) {
    const withDefaults = {
      preferQuoteReply: false,
      ts: Date.now(),
      ...entry
    };
    if (withDefaults.isGroup) {
      scheduleGroupIncoming(withDefaults);
      return;
    }
    scheduleDirectIncoming(withDefaults);
  }

  /** presence.update: { id: chat, presences: { participante: { lastKnownPresence } } }. */
  function onPresenceUpdate(update = {}) {
    const chat = jidNormalizedUser(update?.id ?? "");
    if (!chat) return;
    for (const [participant, info] of Object.entries(update?.presences ?? {})) {
      const presence = info?.lastKnownPresence;
      typing.set(chat, participant, presence);
      if (presence === "paused" && !chat.endsWith("@g.us")) shortenPendingForChat(chat);
    }
  }


  /** Invalidate in-flight replies when user sends a new message (must stay inside closure). */
  function bumpInterrupt(sessionId) {
    interruptBySession.set(sessionId, Date.now());
  }

  function shouldDropGroupQueueItem(item, groupEpoch, activation) {
    if (!item?.isGroup || !item.remoteJid) return false;
    if (item.tetosCommand) return false;
    const channelKey = item.remoteJid;
    if ((groupChannelEpoch.get(channelKey) ?? 0) !== groupEpoch) return true;
    if (activation && !activation.isGroupActive(channelKey)) return true;
    // Mandaram calar o grupo enquanto esta resposta era gerada → não manda.
    if (runtime.groupEngagement?.isMuted?.(channelKey)) return true;
    return false;
  }

  function abortGroupChannel(channelKey) {
    const id = String(channelKey ?? "").trim();
    if (!id) return { clearedPending: 0, clearedQueue: 0, interruptedSessions: 0 };

    groupChannelEpoch.set(id, (groupChannelEpoch.get(id) ?? 0) + 1);

    const sessions = new Set();
    const pending = pendingByGroupChannel.get(id);
    if (pending?.timer) clearTimeout(pending.timer);
    for (const entry of pending?.entries ?? []) {
      const sid = entry.sessionId ?? entry.userId;
      if (sid) sessions.add(sid);
    }
    const clearedPending = pending?.entries?.length ?? 0;
    pendingByGroupChannel.delete(id);

    const queue = queueByGroupChannel.get(id) ?? [];
    for (const item of queue) {
      const sid = item.sessionId ?? item.userId;
      if (sid) sessions.add(sid);
    }
    const clearedQueue = queue.length;
    queueByGroupChannel.delete(id);

    const active = currentSessionByGroupChannel.get(id);
    if (active) sessions.add(active);

    for (const sid of sessions) bumpInterrupt(sid);

    if (clearedPending || clearedQueue || sessions.size) {
      console.log(
        `[whatsapp] grupo abortado: pendente=${clearedPending} fila=${clearedQueue} sessoes=${sessions.size} (${id})`
      );
    }

    return {
      clearedPending,
      clearedQueue,
      interruptedSessions: sessions.size
    };
  }

  function shouldBumpInterruptOnEnqueue(entry = {}) {
    const text = String(entry.message ?? "").trim();
    if (!text) return false;
    if (/^\[(sticker|image|video|gif|audio|figurinha)\]/i.test(text)) return false;
    return true;
  }

  const IMMEDIATE_ACTION_PRIORITY = {
    react: 1,
    message: 2,
    voice: 2,
    sticker: 3,
    silence: 4,
    repertoire_mode: 5,
    url_download: 6,
    media: 7,
    toimage: 7,
    generate_image: 7,
    save_sticker: 9
  };

  function sortImmediateActions(actions = []) {
    return [...actions].sort(
      (a, b) =>
        (IMMEDIATE_ACTION_PRIORITY[a.type] ?? 5) - (IMMEDIATE_ACTION_PRIORITY[b.type] ?? 5)
    );
  }

  /** Já recebemos o texto — não esperar grace de "composing" do turno anterior (evita +atraso antes do modelo). */
  function clearTypingGrace(chatJid, participantJid = null) {
    typing.clear(chatJid, participantJid);
  }

  /** Mensagem que ela manda por iniciativa própria: mesmo caminho das respostas (digitando, bolhas, histórico). */
  async function sendProactive({ remoteJid, userId, sessionId, texts = [] } = {}) {
    if (!remoteJid || !texts.length) return false;
    if (runningBySession.has(sessionId)) return false;
    const token = interruptBySession.get(sessionId) ?? 0;
    interruptBySession.set(sessionId, token);
    await sendReplies(remoteJid, userId, sessionId, texts, token, { allowReply: true });
    return interruptBySession.get(sessionId) === token;
  }

  return {
    scheduleIncoming,
    onPresenceUpdate,
    bumpInterrupt,
    clearTypingGrace,
    abortGroupChannel,
    abortPendingMediaHold,
    sendProactive
  };
}
