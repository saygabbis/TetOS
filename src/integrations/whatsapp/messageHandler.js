import { existsSync, readFileSync } from "node:fs";
import { handleIncomingMessage } from "../../app/createRuntime.js";
import { withGenerationSlot } from "../../infra/concurrency/generationSlot.js";
import { touchInboundActivity } from "./inboundLiveness.js";
import { waAgentDebugLog } from "./waDebugLog.js";
import { jidNormalizedUser, downloadContentFromMessage, normalizeMessageContent } from "baileys";
import { planWhatsAppReaction } from "./reactionPlanner.js";
import { persistMedia, fileExtFromDocumentMessage } from "./mediaStore.js";
import { resolvePassiveModeAction } from "../../core/channels/passiveModeAction.js";
import { resolveStickerAsset } from "./stickerAssets.js";
import { ChatService } from "../../modules/chat/chatService.js";
import { resolveCloseDecision } from "../../core/brain/ConversationPhaseEngine.js";
import { detectVulnerability } from "../../core/brain/vulnerabilityDetect.js";
import { ChatCommandQueue } from "./chatCommandQueue.js";
import { ChatMediaHistoryStore } from "./chatMediaHistoryStore.js";
import { resolveCommandTarget } from "./commandTargetResolver.js";
import { MediaProcessor } from "../../core/media/mediaProcessor.js";
import { resolveTimingConfig, estimateTypingDelayMs as estimateTypingFromCfg } from "../../core/timing/timingConfig.js";
import { ChatMessageIndex } from "./chatMessageIndex.js";
import {
  botMentionedInJids,
  buildOutgoingQuoteKey,
  classifyTetoAddress,
  extractContextInfo,
  extractQuotedText,
  isQuotedMessageFromBot,
  shouldQuoteOutgoing
} from "./messageContext.js";
import { planGroupTurnSegments } from "./groupTurnPlanner.js";
import { parseTetoSlashCommand, handleTetoSlashCommand } from "./tetoSlashCommands.js";
import {
  canonicalSessionId,
  canonicalUserId,
  isOwnerContact,
  resolveOwnerActorId
} from "../../core/channels/userActivity.js";
import {
  buildIdentityIndex,
  cleanDisplayName,
  extractLocalPart,
  isLikelyPhoneNumber,
  normalizeIncomingMentions,
  recordWaIdentity
} from "../../core/channels/waIdentity.js";
import { applyWhatsAppMentions } from "./mentionResolver.js";
import { createProcessedCommandDeduper } from "./processedCommandDeduper.js";

function extractPhone(remoteJid = "") {
  return String(remoteJid)
    .replace(/@.+$/, "")
    .replace(/:\d+$/, "");
}

/** Alinha ao Baileys: documento com legenda vem em `documentWithCaptionMessage`, não só em `documentMessage`. */
function unwrapMessage(message = {}) {
  const normalized = normalizeMessageContent(message);
  return normalized ?? message ?? {};
}

function extractText(message = {}) {
  const unwrapped = unwrapMessage(message);
  return (
    unwrapped?.conversation ??
    unwrapped?.extendedTextMessage?.text ??
    unwrapped?.imageMessage?.caption ??
    unwrapped?.videoMessage?.caption ??
    unwrapped?.documentMessage?.caption ??
    unwrapped?.stickerMessage?.fileName ??
    unwrapped?.buttonsResponseMessage?.selectedButtonId ??
    unwrapped?.listResponseMessage?.title ??
    ""
  );
}

function extractLinks(text = "") {
  const matches = String(text).match(/https?:\/\/[^\s]+/gi);
  return matches ? [...new Set(matches)] : [];
}

function classifyContent(text = "") {
  const lower = String(text ?? "").toLowerCase();
  if (!lower.trim()) return "empty";
  if (/(nsfw|18\+|porn|nude|putaria|sexo|xxx)/i.test(lower)) return "sensitive_nsfw";
  return "general";
}

function logThinking(runtime, payload = {}) {
  const {
    phase = "unknown",
    userId = "unknown",
    remoteJid = "unknown",
    detail = ""
  } = payload;
  const detailText = String(detail ?? "").trim();
  if (!runtime?.defaults?.thinkingLogsEnabled) return;
  console.log(
    `[thinking] phase=${phase} user=${userId} chat=${remoteJid}${detailText ? ` detail="${detailText}"` : ""}`
  );
}

function detectMediaKind(unwrappedMessage = {}) {
  if (unwrappedMessage?.audioMessage) return "audio";
  if (unwrappedMessage?.imageMessage) return "image";
  if (unwrappedMessage?.videoMessage?.gifPlayback) return "gif";
  if (unwrappedMessage?.videoMessage) return "video";
  if (unwrappedMessage?.stickerMessage) return "sticker";
  if (unwrappedMessage?.documentMessage) {
    const mime = String(unwrappedMessage.documentMessage?.mimetype ?? "").toLowerCase();
    if (/^image\//.test(mime)) return "image";
    if (/^video\//.test(mime)) return "video";
    return "document";
  }
  return "text";
}

function buildIncomingAudit(payload = {}) {
  const {
    remoteJid,
    userId,
    isGroup,
    text,
    links,
    media,
    quotedMessage,
    isReply,
    isDirectMention,
    mentionHint,
    closeDecision,
    messageId,
    participantId,
    pushName
  } = payload;
  return {
    ts: new Date().toISOString(),
    remoteJid,
    userId,
    participantId: participantId || null,
    pushName: pushName || null,
    isGroup: Boolean(isGroup),
    messageId: messageId || null,
    text: text || "",
    links: Array.isArray(links) ? links : [],
    mediaType: media?.type ?? "none",
    mediaPath: media?.path ?? null,
    mediaCaption: media?.caption ?? null,
    mediaTranscript: media?.transcript ?? null,
    isReply: Boolean(isReply),
    quotedMessage: quotedMessage || null,
    isDirectMention: Boolean(isDirectMention),
    mentionCount: Array.isArray(mentionHint) ? mentionHint.length : 0,
    closeDecision: closeDecision || null
  };
}

function logIncomingAudit(runtime, payload = {}) {
  if (!runtime?.defaults?.thinkingLogsEnabled) return;
  const audit = buildIncomingAudit(payload);
  console.log(`[audit.incoming] ${JSON.stringify(audit)}`);
}

function logOutgoingAudit(runtime, payload = {}) {
  if (!runtime?.defaults?.thinkingLogsEnabled) return;
  const audit = buildIncomingAudit(payload);
  console.log(`[audit.outgoing] ${JSON.stringify(audit)}`);
}

function inferEditReason(beforeText = "", afterText = "") {
  const before = String(beforeText ?? "").trim();
  const after = String(afterText ?? "").trim();
  if (!before && after) return "complemento";
  if (before && !after) return "limpeza";
  if (before.toLowerCase() === after.toLowerCase() && before !== after) return "formatacao";
  if (Math.abs(before.length - after.length) <= 3) return "correcao_rapida";
  if (after.length > before.length) return "detalhamento";
  if (after.length < before.length) return "resumo";
  return "nao_informado";
}

function buildMessageSnapshot({ messageId, remoteJid, actorId, text, mediaType, quotedMessage }) {
  return {
    messageId: messageId ?? null,
    remoteJid: remoteJid ?? null,
    actorId: actorId ?? null,
    text: String(text ?? ""),
    mediaType: mediaType ?? null,
    quotedMessage: quotedMessage ?? null,
    ts: new Date().toISOString()
  };
}

function extractUpdatedText(update = {}) {
  const msg = update?.update?.message;
  if (!msg) return "";
  return extractText(msg).trim();
}

function parseWhatsAppCommand(text = "", prefix = ".") {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith(prefix)) return null;
  const withoutPrefix = raw.slice(prefix.length).trim();
  if (!withoutPrefix) return null;
  const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
  const command = String(cmdRaw ?? "").toLowerCase();
  const aliases = {
    stiker: "sticker",
    fstiker: "fsticker",
    cstiker: "csticker",
    ajuda: "help",
    comandos: "help",
    commands: "help"
  };
  const normalized = aliases[command] ?? command;
  if (!["sticker", "fsticker", "csticker", "toimg", "help"].includes(normalized)) {
    return null;
  }
  return { command: normalized, args };
}

/** Texto do `.help` — só usado no número de comandos de mídia (ou sessão única `full`). */
function formatWhatsAppHelpText(prefix = ".") {
  const p = String(prefix ?? ".");
  const c = (name) => `${p}${name}`;
  return [
    "*Comandos TetOS*",
    "",
    `${c("help")} — Esta lista (também ${p}ajuda).`,
    `${c("sticker")} — Gera figurinha a partir de imagem/vídeo/GIF (também se mandar como documento, formatos aceitos: imagem, GIF, vídeo). Usa a mídia da mensagem, resposta (reply) ou a última mídia recente no chat. Enche o quadrado (stretch).`,
    `${c("fsticker")} — Igual ao anterior, mas mantém tudo visível dentro da figurinha sem cortar (contain).`,
    `${c("csticker")} — Recorta o centro para caber na figurinha (crop).`,
    `${c("toimg")} — Figurinha → imagem ou GIF/vídeo (reply ou anexo à figurinha).`
  ].join("\n");
}

function inferDocumentAsMedia(unwrappedMessage = {}) {
  const doc = unwrappedMessage?.documentMessage;
  if (!doc) return null;
  const mime = String(doc?.mimetype ?? "").toLowerCase();
  const name = String(doc?.fileName ?? "").toLowerCase();
  if (/^image\//.test(mime) || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    return { type: "image", doc };
  }
  if (/^video\//.test(mime) || /\.(mp4|webm|mov|m4v|mkv)$/.test(name)) {
    return { type: "video", doc };
  }
  if (/gif/.test(mime) || /\.gif$/.test(name)) {
    return { type: "gif", doc };
  }
  return null;
}

function extractParticipantJid(incoming) {
  const participant =
    incoming?.key?.participant ??
    incoming?.participant ??
    "";
  return jidNormalizedUser(participant);
}

function extractParticipantPhone(incoming) {
  const pn =
    incoming?.key?.participantPn ??
    incoming?.participantPn ??
    "";
  if (!pn) return "";
  return extractPhone(jidNormalizedUser(pn));
}

/** JID do remetente em grupo (LID ou tel); legado — preferir extractParticipantJid. */
function extractParticipant(incoming) {
  const phone = extractParticipantPhone(incoming);
  if (phone) return `${phone}@s.whatsapp.net`;
  return extractParticipantJid(incoming);
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function createConversationOrchestrator(
  socket,
  runtime,
  { chatMessageIndex = null, botJid = "", botPhone = "", logPrefix = "[whatsapp]" } = {}
) {
  const timingCfg = resolveTimingConfig(runtime?.defaults ?? {});
  const pendingBySession = new Map();
  const pendingByGroupChannel = new Map();
  const queueBySession = new Map();
  const queueByGroupChannel = new Map();
  const runningBySession = new Set();
  const runningByGroupChannel = new Set();
  const typingByUser = new Map();
  const interruptBySession = new Map();
  /** @type {Map<string, { messagesSinceLastReaction: number, lastReactionAt: number }>} */
  const reactionStateByUser = new Map();

  async function sendReplies(remoteJid, userId, sessionId, replies = [], token = 0, options = {}) {
    const quoteKey = options?.quoteMessageKey ?? null;
    if (!runtime.defaults.replyEnabled) return;
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
          typingDelayMs = estimateTypingFromCfg(content, index, timingCfg);
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
            Math.max(timingCfg.firstBubbleTypingFloorMs, base + extraDelay)
          );
        }
        if (index === 0 && needsTyping && typingDelayMs > 0) {
          await sleep(randBetween(timingCfg.postModelBeforeBubbleMinMs, timingCfg.postModelBeforeBubbleMaxMs));
        }
        if (needsTyping && typingDelayMs > 0 && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("composing", remoteJid);
            await sleep(typingDelayMs);
            await socket.sendPresenceUpdate("paused", remoteJid);
          } catch (error) {
            console.warn(`${logPrefix} typing simulation failed for ${remotePhone}: ${error.message}`);
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
        const normalizedQuote = buildOutgoingQuoteKey(rawQuote, remoteJid, {
          participantId: options?.participantId ?? null,
          participantJid: options?.participantJid ?? null
        });
        if (index === 0 && normalizedQuote?.id) {
          console.log(`${logPrefix} outgoing quote id=${normalizedQuote.id} → ${remoteJid}`);
        }
        console.log(`${logPrefix} outgoing ${remoteJid}: ${content}`);
        const rosterMembers = options?.groupRoster?.members ?? [];
        const { text: mentionText, mentions } = applyWhatsAppMentions(content, rosterMembers);
        const mentionPayload = mentions.length ? { mentions } : {};
        const payload = normalizedQuote
          ? { text: mentionText, quoted: normalizedQuote, ...mentionPayload }
          : { text: mentionText, ...mentionPayload };
        const sendTask = socket.sendMessage(remoteJid, payload);
        const sent = await Promise.race([
          sendTask,
          new Promise((_, reject) => setTimeout(() => reject(new Error("send timeout")), 8000))
        ]).catch((error) => {
          console.error(`${logPrefix} send failed to ${remoteJid}:`, error.message);
          return null;
        });
        const sentId = sent?.key?.id ?? sent?.message?.key?.id ?? null;
        if (sentId && chatMessageIndex) {
          chatMessageIndex.append({
            channelId: remoteJid,
            messageId: sentId,
            actorId: "teto",
            text: content,
            isFromBot: true,
            remoteJid,
            quotedMessageId: normalizedQuote?.id ?? null
          });
        }
        if (index < replies.length - 1) {
          const planned = options?.bubbleDelays?.[index + 1];
          const interPartDelayMs =
            Number.isFinite(planned) && planned > 0
              ? planned
              : randBetween(timingCfg.multiPartDelayMinMs, timingCfg.multiPartDelayMaxMs);
          await sleep(interPartDelayMs);
        }
      }
    } finally {
      if (typeof socket.sendPresenceUpdate === "function") {
        try {
          await socket.sendPresenceUpdate("paused", remoteJid);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function processQueueItem(item) {
    const sessionId = item.sessionId ?? item.userId;
    const typingUntil = typingByUser.get(item.userId) ?? 0;
        const token = Date.now();
        interruptBySession.set(sessionId, token);
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
        if (shouldGenerate) {
          console.log(`${logPrefix} generating reply for ${item.userId}…`);
          if (typeof socket.sendPresenceUpdate === "function") {
            try {
              await socket.sendPresenceUpdate("composing", item.remoteJid);
            } catch (e) {
              console.warn(`${logPrefix} composing (during generation) failed: ${e.message}`);
            }
          }
        }
        let timingPlan = null;
        const shouldRunPipeline =
          runtime.defaults.replyEnabled || runtime.defaults.learningModeEnabled;
        if (shouldRunPipeline) {
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
                    isOwner: item.isOwner ?? false
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
              const targetLatency = (timingPlan?.readDelayMs ?? 0) + (timingPlan?.thinkDelayMs ?? 0);
              const remaining = Math.max(0, targetLatency - (Date.now() - genStart));
              if (remaining > 0 && replies.length > 0) {
                await sleep(remaining);
              }
              item.passiveMode = out?.policy?.mode ?? "full";
              if (item.passiveMode === "react_only") {
                replies = [];
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
        } else {
          replies = [];
          item.passiveMode = "learn_only";
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
        if (!hasOutgoing && shouldRunPipeline && runtime.defaults.replyEnabled) {
          console.warn(
            `${logPrefix} empty reply for ${item.userId} (close=${item.closeDecision} mode=${item.passiveMode ?? "?"} msg="${String(item.message ?? "").slice(0, 80)}")`
          );
        }
        if (hasOutgoing && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("composing", item.remoteJid);
          } catch (e) {
            console.warn(`${logPrefix} composing (during generation) failed: ${e.message}`);
          }
        }

        runtime.timeStore?.markSeen(item.userId, Date.now(), item.sessionId);
        runtime.userPatterns?.recordInteraction(item.userId);
        if (!hasOutgoing && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("paused", item.remoteJid);
          } catch (_) {
            /* ignore */
          }
        }
        if (interruptBySession.get(sessionId) !== token) return;
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
        const forcedReaction = item.closeDecision === "react" || passiveAction.type === "react_only" ? "❤️" : null;
        const emoji = plan.emoji ?? forcedReaction;
        const reactionKey = buildOutgoingQuoteKey(item.messageKey, item.remoteJid, {
          participantId: item.participantId ?? null,
          participantJid: item.participantJid ?? item.messageKey?.participant ?? null
        });
        const reacted = Boolean(emoji && reactionKey && typeof socket.sendMessage === "function");
        if (reacted && runtime.defaults.replyEnabled) {
          try {
            await socket.sendMessage(item.remoteJid, {
              react: { text: emoji, key: reactionKey }
            });
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
        if (!reacted && passiveAction.type === "sticker_only" && runtime.defaults.replyEnabled) {
          const stickerAsset = resolveStickerAsset(passiveAction.stickerKey, runtime.defaults.stickersPath);
          if (stickerAsset) {
            try {
              await socket.sendMessage(item.remoteJid, { sticker: stickerAsset });
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

        if (!reacted && runtime.defaults.replyEnabled) {
          const hasOutgoing =
            Array.isArray(replies) && replies.some((r) => String(r ?? "").trim().length > 0);
          if (hasOutgoing) {
            let waitForTypingMs = Math.max(0, typingUntil - Date.now());
            if (waitForTypingMs > 0) {
              if (Math.random() < 0.14) {
                waitForTypingMs = Math.min(waitForTypingMs, randBetween(120, 420));
              } else if (Math.random() < 0.09) {
                waitForTypingMs = Math.floor(waitForTypingMs * 0.32);
              }
              await sleep(waitForTypingMs);
            }
            const debounceMs = randBetween(timingCfg.interruptDebounceMinMs, timingCfg.interruptDebounceMaxMs);
            await sleep(debounceMs);
          }
          const shouldQuote = shouldQuoteOutgoing(item);
          const quoteKeys = Array.isArray(item.quoteMessageKeys)
            ? item.quoteMessageKeys
            : shouldQuote
              ? replies.map((_, i) => (i === 0 ? item.messageKey : item.quoteMessageKeys?.[i] ?? null))
              : [];
          const bubbleProcessor = runtime.chatService?.getProcessor?.({ sessionId: item.sessionId });
          const bubbleDelays = bubbleProcessor?.lastBubblePlan?.delays ?? null;
          await sendReplies(item.remoteJid, item.userId, item.sessionId, replies, token, {
            softened,
            timingPlan,
            bubbleDelays,
            groupRoster: item.groupRoster ?? null,
            participantId: item.participantId ?? null,
            participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
            quoteMessageKey: shouldQuote ? item.messageKey ?? null : null,
            quoteMessageKeys: quoteKeys.filter(Boolean).length ? quoteKeys : undefined
          });
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
    }
  }

  async function drainGroupChannel(channelKey) {
    if (runningByGroupChannel.has(channelKey)) return;
    runningByGroupChannel.add(channelKey);
    try {
      while (queueByGroupChannel.get(channelKey)?.length) {
        const item = queueByGroupChannel.get(channelKey).shift();
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
    if (runningByGroupChannel.has(channelKey)) {
      bumpInterrupt(entry.sessionId ?? entry.userId);
    }
    const queue = queueByGroupChannel.get(channelKey) ?? [];
    queue.push(entry);
    queueByGroupChannel.set(channelKey, queue);
    drainGroupChannel(channelKey).catch((error) => {
      console.error("[whatsapp] group channel queue error:", error.message);
    });
  }

  function coalesceQueueEntries(entries = []) {
    if (entries.length <= 1) return entries;
    const first = entries[0];
    const merged = entries.slice(1).reduce(
      (acc, cur) => ({
        ...acc,
        message: `${acc.message}\n${cur.message}`.trim(),
        messageKey: cur.messageKey ?? acc.messageKey,
        media: cur.media ?? acc.media,
        quotedMessage: cur.quotedMessage ?? acc.quotedMessage,
        quotedMessageId: cur.quotedMessageId ?? acc.quotedMessageId,
        replyThreadContext: cur.replyThreadContext ?? acc.replyThreadContext,
        isReply: cur.isReply || acc.isReply,
        isReplyToBot: cur.isReplyToBot || acc.isReplyToBot,
        isDirectMention: cur.isDirectMention || acc.isDirectMention,
        groupEngagementActive: cur.groupEngagementActive || acc.groupEngagementActive,
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

    if (runningBySession.has(key)) {
      bumpInterrupt(key);
    }

    if (queue.length >= maxCoalesce - 1) {
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

  function scheduleGroupIncoming(entry) {
    const channelKey = entry.remoteJid;
    let pending = pendingByGroupChannel.get(channelKey) ?? { entries: [], timer: null };

    if (pending.timer) clearTimeout(pending.timer);
    pending.entries.push({ ...entry, ts: entry.ts ?? Date.now() });

    const stillTyping = pending.entries.some(
      (e) => (typingByUser.get(e.userId) ?? 0) > Date.now()
    );
    const baseBatch = timingCfg.groupBatchWindowMs;
    const batchMs = stillTyping
      ? Math.min(6500, Math.round(baseBatch * 2.4))
      : baseBatch;

    pending.timer = setTimeout(() => {
      const collected = pending.entries;
      pendingByGroupChannel.delete(channelKey);
      const segments = planGroupTurnSegments(collected);
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
    }, batchMs);

    pendingByGroupChannel.set(channelKey, pending);
  }

  function scheduleDirectIncoming(entry) {
    const key = entry.sessionId ?? entry.userId;
    let previous = pendingBySession.get(key);

    const differentQuote =
      entry.isReply &&
      previous &&
      previous.quotedMessageId &&
      entry.quotedMessageId &&
      previous.quotedMessageId !== entry.quotedMessageId;

    // Reply explícito (quote) → não mistura quotes diferentes; flush o pendente
    if (entry.isReply && previous?.timer) {
      clearTimeout(previous.timer);
      const flushed = { ...previous };
      delete flushed.timer;
      pendingBySession.delete(key);
      enqueue(flushed);
      previous = null;
    } else if (differentQuote && previous?.timer) {
      clearTimeout(previous.timer);
      const flushed = { ...previous };
      delete flushed.timer;
      pendingBySession.delete(key);
      enqueue(flushed);
      previous = null;
    }

    if (previous?.timer) clearTimeout(previous.timer);
    const canMergeQuotes =
      !entry.isReply ||
      !previous?.isReply ||
      !entry.quotedMessageId ||
      !previous.quotedMessageId ||
      entry.quotedMessageId === previous.quotedMessageId;

    const merged = previous && canMergeQuotes
      ? {
          ...entry,
          message: `${previous.message}\n${entry.message}`.trim(),
          messageKey: entry.messageKey ?? previous.messageKey,
          media: entry.media ?? previous.media,
          quotedMessage: entry.quotedMessage ?? previous.quotedMessage,
          quotedMessageId: entry.quotedMessageId ?? previous.quotedMessageId,
          replyThreadContext: entry.replyThreadContext ?? previous.replyThreadContext,
          isReply: entry.isReply || previous.isReply,
          isReplyToBot: entry.isReplyToBot || previous.isReplyToBot,
          isDirectMention: entry.isDirectMention || previous.isDirectMention,
          groupEngagementActive: entry.groupEngagementActive || previous.groupEngagementActive,
          groupAddressKind: entry.groupAddressKind ?? previous.groupAddressKind,
          pushName: entry.pushName ?? previous.pushName,
          isOwner: entry.isOwner || previous.isOwner,
          batchedCount: (previous.batchedCount ?? 1) + 1
        }
      : { ...entry, batchedCount: 1 };

    const typingUntil = typingByUser.get(entry.userId) ?? 0;
    const stillTyping = typingUntil > Date.now();
    const baseBatch = entry.isGroup ? timingCfg.groupBatchWindowMs : timingCfg.batchWindowMs;
    const batchMs = stillTyping
      ? Math.min(5500, Math.round(baseBatch * 2.2))
      : baseBatch;

    const timer = setTimeout(() => {
      pendingBySession.delete(key);
      if (merged.batchedCount > 1) {
        console.log(`[whatsapp] batch ${merged.batchedCount} msgs → 1 reply (${key})`);
      }
      enqueue(merged);
    }, batchMs);
    pendingBySession.set(key, { ...merged, timer });
  }

  function scheduleIncoming(entry) {
    const withDefaults = {
      preferQuoteReply: true,
      ts: Date.now(),
      ...entry
    };
    if (withDefaults.isGroup) {
      scheduleGroupIncoming(withDefaults);
      return;
    }
    scheduleDirectIncoming(withDefaults);
  }

  function onPresenceUpdate(update = {}) {
    const id = jidNormalizedUser(update?.id ?? "");
    const userId = extractPhone(id);
    if (!userId) return;
    const presences = update?.presences ?? {};
    const userPresence = presences[id] ?? presences[`${userId}@s.whatsapp.net`] ?? null;
    const isTyping = userPresence?.lastKnownPresence === "composing";
    if (isTyping) {
      typingByUser.set(userId, Date.now() + timingCfg.typingGraceMs);
    }
  }


  /** Invalidate in-flight replies when user sends a new message (must stay inside closure). */
  function bumpInterrupt(sessionId) {
    interruptBySession.set(sessionId, Date.now());
  }

  /** Já recebemos o texto — não esperar grace de "composing" do turno anterior (evita +atraso antes do modelo). */
  function clearTypingGrace(userId) {
    typingByUser.delete(userId);
  }

  return { scheduleIncoming, onPresenceUpdate, bumpInterrupt, clearTypingGrace };
}

export function registerMessageHandler({ socket, runtime, role = "full" }) {
  if (socket.__tetosHandlerRegistered) return;
  socket.__tetosHandlerRegistered = true;

  const botChatRole =
    role === "media" && runtime.defaults.whatsappMode === "dual" && runtime.defaults.whatsappMainObserveOnly;
  const waLogPrefix = role === "media" ? "[whatsapp:media]" : "[whatsapp]";
  const chatMessageIndex = new ChatMessageIndex({ maxPerChannel: 80 });
  const botJidForHandler = jidNormalizedUser(socket?.user?.id ?? socket?.user?.jid ?? "");
  const botPhoneForHandler = extractPhone(botJidForHandler);
  const orchestrator =
    role === "media" && !botChatRole
      ? null
      : createConversationOrchestrator(socket, runtime, {
          chatMessageIndex,
          botJid: botJidForHandler,
          botPhone: botPhoneForHandler,
          logPrefix: waLogPrefix
        });
  const messageSnapshotById = new Map();
  const commandQueue = new ChatCommandQueue();
  const mediaHistoryStore = new ChatMediaHistoryStore(runtime.defaults.commandMediaHistoryLimit);
  const mediaProcessor = new MediaProcessor({
    outputDir: runtime.defaults.commandMediaDerivedPath,
    maxStickerBytes: runtime.defaults.tetosStickerMaxBytes
  });
  const seenMessageIds = new Map();
  const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
  const processedCommandDeduper = createProcessedCommandDeduper();
  const skipVisionEnrichment = role === "media" && !botChatRole;
  console.log(
    `${waLogPrefix} handler ativo${botChatRole ? " (responde chat)" : role === "main" ? " (só aprende)" : ""}`
  );
  if (orchestrator) {
    socket.ev.on("presence.update", orchestrator.onPresenceUpdate);
  }

  async function handleMediaCommand({
    incoming,
    parsedCommand,
    remoteJid,
    userId,
    media
  }) {
    return commandQueue.enqueue(remoteJid, async () => {
      const startedAt = Date.now();
      const resolved = await resolveCommandTarget({
        incoming,
        remoteJid,
        userId,
        media,
        historyStore: mediaHistoryStore,
        persistMedia,
        downloadContentFromMessage,
        basePath: runtime.defaults.whatsappMediaPath
      });
      if (!resolved?.media?.path) {
        await socket.sendMessage(remoteJid, {
          text: "Nao achei midia valida. Use no anexo, reply, ou mande uma midia recente."
        });
        runtime.eventLedger?.append?.({
          eventType: "command.media",
          commandName: parsedCommand.command,
          status: "error",
          reason: "target_not_found",
          remoteJid,
          actorId: userId
        });
        return true;
      }

      try {
        let output = null;
        if (parsedCommand.command === "sticker") {
          output = await mediaProcessor.toSticker(resolved.media, "stretch");
        } else if (parsedCommand.command === "fsticker") {
          output = await mediaProcessor.toSticker(resolved.media, "contain");
        } else if (parsedCommand.command === "csticker") {
          output = await mediaProcessor.toSticker(resolved.media, "crop");
        } else if (parsedCommand.command === "toimg") {
          output = await mediaProcessor.toMediaFromSticker(resolved.media);
        }

        const skipToimgPlayback =
          parsedCommand.command === "toimg" &&
          output.kind === "video" &&
          output.toimgPlaybackSkipped === true;
        if (!output?.path && !skipToimgPlayback) throw new Error("processing failed");

        const outBuffer = output.path ? readFileSync(output.path) : null;


        if (parsedCommand.command === "toimg") {
          if (output.kind === "video") {
            if (outBuffer) {
              const playbackMime = output.toimgPlaybackMime ?? "video/mp4";
              const playbackPayload = {
                video: outBuffer,
                gifPlayback: true,
                mimetype: playbackMime,
                ...(playbackMime === "video/mp4" &&
                typeof output.toimgPlaybackSeconds === "number"
                  ? { seconds: output.toimgPlaybackSeconds }
                  : {})
              };


              await socket.sendMessage(remoteJid, playbackPayload);
            }
            const gifDoc = output.toimgGifPath;
            if (gifDoc && existsSync(gifDoc)) {

              await socket.sendMessage(remoteJid, {
                document: readFileSync(gifDoc),
                mimetype: "image/gif",
                fileName: "sticker-convertido.gif"
              });
            }
          } else {
            await socket.sendMessage(remoteJid, { image: outBuffer });
            await socket.sendMessage(remoteJid, {
              document: outBuffer,
              mimetype: "image/png",
              fileName: "sticker-convertido.png"
            });
          }
        } else if (output.kind === "video") {

          const sendResult = await socket.sendMessage(remoteJid, { sticker: outBuffer });

        } else {

          const sendResult = await socket.sendMessage(remoteJid, { sticker: outBuffer });

        }

        const elapsedMs = Date.now() - startedAt;
        if (runtime.defaults.thinkingLogsEnabled) {
          console.log(`[audit.command] ${JSON.stringify({
            ts: new Date().toISOString(),
            commandName: parsedCommand.command,
            status: "ok",
            targetSource: resolved.source,
            inputType: resolved.media.type,
            outputType: output.kind,
            remoteJid,
            actorId: userId,
            elapsedMs
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "command.media",
          commandName: parsedCommand.command,
          status: "ok",
          targetSource: resolved.source,
          inputType: resolved.media.type,
          outputType: output.kind,
          remoteJid,
          actorId: userId,
          elapsedMs
        });
        return true;
      } catch (error) {
        await socket.sendMessage(remoteJid, {
          text: `Falha ao processar ${parsedCommand.command}: ${error.message}`
        });
        runtime.eventLedger?.append?.({
          eventType: "command.media",
          commandName: parsedCommand.command,
          status: "error",
          reason: error.message,
          targetSource: resolved.source,
          inputType: resolved.media?.type ?? null,
          remoteJid,
          actorId: userId
        });
        if (runtime.defaults.thinkingLogsEnabled) {
          console.log(`[audit.command] ${JSON.stringify({
            ts: new Date().toISOString(),
            commandName: parsedCommand.command,
            status: "error",
            reason: error.message,
            targetSource: resolved.source,
            remoteJid,
            actorId: userId
          })}`);
        }
        return true;
      }
    });
  }

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    const batch = messages ?? [];
    const inboundSource =
      botChatRole || role === "full" ? "bot" : role === "main" ? "main" : "media";
    touchInboundActivity(inboundSource);
    // #region agent log
    waAgentDebugLog({
      runId: "wa-inbound",
      hypothesisId: "H2-H4",
      location: "messageHandler.js:messages.upsert",
      message: "upsert received",
      data: {
        role,
        botChatRole,
        type: type ?? null,
        count: batch.length,
        sampleRemoteJid: batch[0]?.key?.remoteJid ?? null,
        sampleFromMe: batch[0]?.key?.fromMe ?? null,
        sampleHasMessage: Boolean(batch[0]?.message)
      }
    });
    // #endregion
    console.log(`${waLogPrefix} upsert type=${type ?? "?"} count=${batch.length}`);

    if (type !== "notify" && type !== "append") {
      // #region agent log
      waAgentDebugLog({
        runId: "wa-inbound",
        hypothesisId: "H4",
        location: "messageHandler.js:messages.upsert",
        message: "upsert type ignored",
        data: { role, type: type ?? null, count: batch.length }
      });
      // #endregion
      if (runtime.defaults.thinkingLogsEnabled && batch.length > 0) {
        console.warn(`${waLogPrefix} upsert ignorado (type=${type}) — msg nao processada`);
      }
      return;
    }

    for (const incoming of batch) {
      try {
        if (!incoming?.message) continue;
        if (incoming?.messageStubType && !incoming.message?.conversation) {
          continue;
        }
        const protocolMessage = incoming?.message?.protocolMessage;
        if (protocolMessage?.key) {
          const deletedId = protocolMessage.key?.id ?? null;
          const deletedRemoteJid = protocolMessage.key?.remoteJid ?? incoming.key?.remoteJid ?? null;
          const previous = deletedId ? messageSnapshotById.get(deletedId) : null;
          const reason = protocolMessage?.type === 0 ? "revoke" : "protocol";
          if (runtime?.defaults?.thinkingLogsEnabled) {
            console.log(`[audit.delete] ${JSON.stringify({
              ts: new Date().toISOString(),
              messageId: deletedId,
              remoteJid: deletedRemoteJid,
              before: previous?.text ?? null,
              reason
            })}`);
          }
          runtime.eventLedger?.append?.({
            eventType: "message.deleted",
            messageId: deletedId,
            remoteJid: deletedRemoteJid,
            beforeText: previous?.text ?? null,
            beforeMediaType: previous?.mediaType ?? null,
            reason
          });
          if (deletedId) {
            messageSnapshotById.delete(deletedId);
          }
          continue;
        }
        if (incoming?.message?.protocolMessage || incoming?.message?.senderKeyDistributionMessage) {
          continue;
        }

        const messageKeyId = incoming.key?.id ?? "";
        if (messageKeyId) {
          const lastSeenAt = seenMessageIds.get(messageKeyId);
          if (lastSeenAt && Date.now() - lastSeenAt < MESSAGE_DEDUPE_TTL_MS) {
            continue;
          }
          seenMessageIds.set(messageKeyId, Date.now());
        }

        const remoteJidRaw = incoming.key?.remoteJid ?? "";
        const remoteJid = jidNormalizedUser(remoteJidRaw);
        if (!remoteJid || remoteJid.endsWith("@broadcast") || remoteJid === "status@broadcast") {
          continue;
        }

        const isGroup = remoteJid.endsWith("@g.us");
        const unwrappedMessage = unwrapMessage(incoming.message);
        let text = extractText(unwrappedMessage).trim();
        const links = extractLinks(text);
        const parsedCommand = parseWhatsAppCommand(text, runtime.defaults.commandPrefix);
        const tetoSlash = parseTetoSlashCommand(text);
        const mediaKind = detectMediaKind(unwrappedMessage);
        const isFromMe = Boolean(incoming.key?.fromMe);
        const hasMediaPayload = Boolean(
          unwrappedMessage?.imageMessage ||
          unwrappedMessage?.videoMessage ||
          unwrappedMessage?.audioMessage ||
          unwrappedMessage?.stickerMessage ||
          unwrappedMessage?.documentMessage
        );
        if (!text && !hasMediaPayload) continue;
        console.log(`${waLogPrefix} ${isFromMe ? "outgoing" : "incoming"} ${remoteJid}: ${text || `[${mediaKind}]`}`);

        const baseUserId = extractPhone(remoteJid);
        const participantJid = isGroup ? extractParticipantJid(incoming) : "";
        const participantPhone = isGroup ? extractParticipantPhone(incoming) : "";
        let participantId = isGroup
          ? extractLocalPart(participantJid) || participantPhone
          : "";
        if (isGroup && !participantId) {
          const msgId = incoming.key?.id ?? "";
          participantId = msgId ? `grp_${String(msgId).slice(-12)}` : `grp_${Date.now()}`;
          console.warn(`[whatsapp] grupo sem participantId em ${remoteJid}; usando ${participantId}`);
        }
        const userId = isGroup
          ? participantId
          : canonicalUserId(runtime, baseUserId, { remoteJid });
        const sessionId = isGroup && participantId
          ? `wa-group:${baseUserId}:${participantId}`
          : canonicalSessionId(runtime, userId, { remoteJid });

        if (isGroup && participantId) {
          const rawParticipantJid = participantJid || extractParticipant(incoming);
          if (rawParticipantJid && /^\d{8,}$/.test(participantId)) {
            runtime.channelRegistry?.recordParticipantJid?.(remoteJid, participantId, rawParticipantJid);
          }
          if (participantPhone && participantJid.includes("@lid")) {
            runtime.channelRegistry?.recordParticipantLink?.(
              remoteJid,
              extractLocalPart(participantJid),
              participantPhone
            );
          }
        }

        if (tetoSlash && !isFromMe && (role !== "media" || botChatRole)) {
          const handled = await handleTetoSlashCommand({
            action: tetoSlash.action,
            userId,
            remoteJid,
            isGroup,
            activationStore: runtime.tetoActivation,
            socket
          });
          if (handled.handled) continue;
        }

        if (parsedCommand?.command === "help") {
          if (role === "media" || role === "full") {
            await socket.sendMessage(remoteJid, {
              text: formatWhatsAppHelpText(runtime.defaults.commandPrefix)
            });
          }
          continue;
        }

        if (role === "media" && !botChatRole) {
          if (!parsedCommand && !hasMediaPayload) continue;
        }

        if (role === "main" && parsedCommand) {
          const hint = String(runtime.defaults.whatsappStickerCommandsDisabledHint ?? "").trim();
          if (hint) {
            await socket.sendMessage(remoteJid, { text: hint });
          }
          continue;
        }

        let historySnapshot = [];
        if (role !== "media" || botChatRole) {
          historySnapshot = runtime.shortTerm.getAll(sessionId);
        }
        let closeDecision = "open";

        if (!isFromMe) {
          orchestrator?.clearTypingGrace(userId);
        }
        const pushName = incoming.pushName?.trim();

        const contextInfo = extractContextInfo(unwrappedMessage);
        const stanzaId = contextInfo?.stanzaId ?? null;
        const quotedSnapshot = stanzaId ? messageSnapshotById.get(stanzaId) : null;
        const botJid = botJidForHandler || jidNormalizedUser(socket?.user?.id ?? socket?.user?.jid ?? "");
        const botPhone = botPhoneForHandler || extractPhone(botJid);
        const botActorIds = new Set(
          ["teto", "self", runtime.defaults.learningTargetUserId, botPhone].filter(Boolean)
        );
        const quotedFromProto = extractQuotedText(contextInfo?.quotedMessage);
        const isReplyToBot = isQuotedMessageFromBot(contextInfo, {
          botJid,
          botPhone,
          snapshot: quotedSnapshot,
          botActorIds,
          messageIndex: chatMessageIndex,
          channelId: remoteJid,
          quotedText: quotedFromProto
        });
        if (isReplyToBot && stanzaId) {
          logThinking(runtime, {
            phase: "reply_to_bot",
            userId,
            remoteJid,
            detail: `quote id=${stanzaId} texto="${(quotedFromProto || quotedSnapshot?.text || "").slice(0, 80)}"`
          });
        }

        const mentionHint = contextInfo?.mentionedJid ?? [];
        const identityIndex = buildIdentityIndex(runtime);
        if (text && (isGroup || mentionHint.length)) {
          text = normalizeIncomingMentions(text, identityIndex, mentionHint);
        }
        let isDirect = false;
        let isReply = Boolean(stanzaId);
        let groupEngagementActive = false;
        let groupAddressKind = "none";

        if (isGroup && !parsedCommand) {
          const hasMention = botMentionedInJids(mentionHint, botJid, botPhone);
          groupAddressKind = classifyTetoAddress(text, { hasMention, isReplyToBot });
          if (isReplyToBot) isReply = true;

          const engagement = runtime.groupEngagement;
          const windowActive = engagement?.isActive?.(remoteJid, userId) ?? false;
          const explicitAddress =
            groupAddressKind === "mention" ||
            groupAddressKind === "reply" ||
            groupAddressKind === "contextual";

          if (explicitAddress || isReplyToBot) {
            isDirect = explicitAddress;
            engagement?.touch?.(remoteJid, userId);
          } else if (windowActive) {
            groupEngagementActive = true;
            isDirect = false;
            engagement?.touch?.(remoteJid, userId);
          } else if (groupAddressKind === "name_ambiguous") {
            logThinking(runtime, {
              phase: "group_filtered",
              userId,
              remoteJid,
              detail: "nome 'teto' sem contexto de chamada — ignorado (subconsciente: não era pra mim)"
            });
          }

          const recalled = runtime.groupMemory?.recall?.(remoteJid, text) ?? [];
          const triggeredRecall = recalled.length > 0;
          const inContext = triggeredRecall || isReplyToBot;
          const allowGroupReply = explicitAddress || groupEngagementActive || inContext;

          runtime.groupMemory?.append?.({
            channelId: remoteJid,
            userId,
            speakerName: pushName || null,
            text: text || `[${mediaKind}]`,
            addressedToTeto: explicitAddress || groupEngagementActive,
            ts: new Date().toISOString()
          });

          if (!allowGroupReply) {
            logThinking(runtime, {
              phase: "group_filtered",
              userId,
              remoteJid,
              detail: "registrado em groupMemory; sem resposta (sem menção/janela/recall)"
            });
            continue;
          }
        } else {
          isReply = Boolean(stanzaId);
        }

        if (role !== "media" || botChatRole) {
          const channelScope = isGroup ? `group:${remoteJid}` : "direct";
          const heuristic = ChatService.decideClosure(text, historySnapshot);
          const trustBond = runtime.brainOrchestrator?.trust?.getBond?.(userId, channelScope) ?? null;
          const repetition = runtime.brainOrchestrator?.repetition?.getSnapshot?.(sessionId) ?? null;
          const profileForClose = runtime.longTerm.getProfile(userId, channelScope);
          const resolved = resolveCloseDecision({
            message: text,
            history: historySnapshot,
            heuristicDecision: heuristic,
            trustBond,
            repetition,
            isDirectTetoCall: ChatService.isDirectTetoCall(text),
            isDirectQuestion: ChatService.isLikelyQuestion(text),
            isDirectMention: isGroup ? isDirect : true,
            isVulnerable: detectVulnerability(text),
            resumedAfterClose: Boolean(profileForClose?.conversationClosedAt),
            sessionId
          });
          closeDecision = resolved.closeDecision ?? "none";
          logThinking(runtime, {
            phase: "close_decision",
            userId,
            remoteJid,
            detail: `decision=${closeDecision} phase=${resolved.analysis?.phase ?? "?"} conf=${(resolved.analysis?.confidence ?? 0).toFixed(2)}`
          });
        }

        if (role !== "media" || botChatRole) {
          recordWaIdentity(runtime, {
            userId,
            remoteJid,
            participantJid: isGroup ? participantJid : remoteJid,
            participantPhone: isGroup ? participantPhone : null,
            pushName,
            channelId: remoteJid,
            isGroup
          });

          const profile = runtime.longTerm.getProfile(userId);
          if (pushName) {
            runtime.longTerm.updateProfile(userId, {
              facts: {
                ...(profile?.facts ?? {}),
                name: pushName,
                displayName: cleanDisplayName(pushName) || profile?.facts?.displayName
              }
            });
          }
          runtime.longTerm.updateProfile(userId, {
            facts: {
              ...(profile?.facts ?? {}),
              lastChannel: isGroup ? "group" : "direct",
              waRemoteJid: remoteJid,
              ...(isLikelyPhoneNumber(userId) ? { waPhone: userId } : {}),
              ...(remoteJid.includes("@lid")
                ? { waLid: extractLocalPart(remoteJid) }
                : {})
            }
          });
        }

        const quotedMessage =
          quotedFromProto ||
          (contextInfo?.quotedMessage ? extractText(contextInfo.quotedMessage).trim() : "") ||
          quotedSnapshot?.text ||
          "";
        const replyThreadContext =
          stanzaId && chatMessageIndex
            ? chatMessageIndex.buildReplyContext(remoteJid, stanzaId, 14)
            : null;

        let media = null;
        try {
          if (unwrappedMessage?.imageMessage && incoming.key?.id) {
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.imageMessage,
              type: "image",
              id: `${incoming.key.id}-image`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            let visualDescription = null;
            if (!skipVisionEnrichment) {
              visualDescription =
                (await runtime.semanticVisionAnalyzer?.analyze?.({
                  filePath: path,
                  mediaType: "image"
                })) ??
                (await runtime.visualAnalyzer?.analyze?.({
                  filePath: path,
                  mediaType: "image"
                }));
              if (visualDescription) {
                runtime.visualAnalyses?.save?.({
                  userId,
                  channelId: remoteJid,
                  mediaPath: path,
                  mediaType: "image",
                  description: visualDescription
                });
              }
            }
            media = {
              type: "image",
              caption: unwrappedMessage.imageMessage?.caption ?? text,
              transcript: visualDescription,
              path
            };
          } else if (unwrappedMessage?.videoMessage && incoming.key?.id) {
            media = {
              type: "video",
              caption: unwrappedMessage.videoMessage?.caption ?? text,
              isAnimated: Boolean(unwrappedMessage.videoMessage?.gifPlayback),
              path: await persistMedia({
                downloadContentFromMessage,
                content: unwrappedMessage.videoMessage,
                type: "video",
                id: `${incoming.key.id}-video`,
                basePath: runtime.defaults.whatsappMediaPath
              })
            };
          } else if (unwrappedMessage?.audioMessage && incoming.key?.id) {
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.audioMessage,
              type: "audio",
              id: `${incoming.key.id}-audio`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            let transcript = null;
            if (!skipVisionEnrichment) {
              transcript = await runtime.audioTranscriber?.transcribe?.({
                filePath: path,
                mimetype: unwrappedMessage.audioMessage?.mimetype,
                seconds: unwrappedMessage.audioMessage?.seconds
              });
              if (transcript) {
                runtime.audioTranscriptions?.save?.({
                  userId,
                  channelId: remoteJid,
                  mediaPath: path,
                  transcript,
                  source: "fallback"
                });
              }
            }
            media = {
              type: "audio",
              transcript,
              caption: text,
              path
            };
          } else if (unwrappedMessage?.stickerMessage && incoming.key?.id) {
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.stickerMessage,
              type: "sticker",
              id: `${incoming.key.id}-sticker`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            const isAnimated = Boolean(unwrappedMessage.stickerMessage?.isAnimated);
            let visualDescription = null;
            if (!skipVisionEnrichment) {
              visualDescription =
                (await runtime.semanticVisionAnalyzer?.analyze?.({
                  filePath: path,
                  mediaType: "sticker",
                  isAnimated
                })) ??
                (await runtime.visualAnalyzer?.analyze?.({
                  filePath: path,
                  mediaType: "sticker",
                  isAnimated
                }));
              if (visualDescription) {
                runtime.visualAnalyses?.save?.({
                  userId,
                  channelId: remoteJid,
                  mediaPath: path,
                  mediaType: "sticker",
                  description: visualDescription
                });
              }
            }
            media = {
              type: "sticker",
              caption: text,
              transcript: visualDescription,
              isAnimated,
              path
            };
          } else if (unwrappedMessage?.documentMessage && incoming.key?.id) {
            const docHint = inferDocumentAsMedia(unwrappedMessage);
            if (docHint) {
              const persistType = docHint.type === "gif" ? "video" : docHint.type;
              const path = await persistMedia({
                downloadContentFromMessage,
                content: docHint.doc,
                type: persistType,
                id: `${incoming.key.id}-document`,
                basePath: runtime.defaults.whatsappMediaPath,
                preferredExt: fileExtFromDocumentMessage(docHint.doc),
                decryptMediaAs: "document"
              });
              if (docHint.type === "image") {
                media = {
                  type: "image",
                  caption: unwrappedMessage.documentMessage?.caption ?? text,
                  path
                };
              } else {
                media = {
                  type: docHint.type === "gif" ? "gif" : "video",
                  caption: unwrappedMessage.documentMessage?.caption ?? text,
                  isAnimated: docHint.type === "gif",
                  path
                };
              }
            }
          }
        } catch (error) {
          runtime.logger?.log?.("whatsapp.media_error", {
            messageId: incoming.key?.id ?? null,
            error: error.message
          });
        }

        if (media?.path && media?.type) {
          mediaHistoryStore.add(remoteJid, {
            messageId: incoming.key?.id ?? null,
            userId,
            media
          });
        }

        if (parsedCommand) {
          const commandMessageId = incoming.key?.id ?? null;
          if (type === "append") {
            if (runtime.defaults.thinkingLogsEnabled) {
              console.log(
                `[audit.command] ${JSON.stringify({
                  ts: new Date().toISOString(),
                  status: "skip_append_replay",
                  commandName: parsedCommand.command,
                  messageId: commandMessageId,
                  remoteJid
                })}`
              );
            }
            continue;
          }
          if (!processedCommandDeduper.claim(commandMessageId)) {
            if (runtime.defaults.thinkingLogsEnabled) {
              console.log(
                `[audit.command] ${JSON.stringify({
                  ts: new Date().toISOString(),
                  status: "skip_duplicate",
                  commandName: parsedCommand.command,
                  messageId: commandMessageId,
                  remoteJid
                })}`
              );
            }
            continue;
          }
          const handled = await handleMediaCommand({
            incoming,
            parsedCommand,
            remoteJid,
            userId,
            media
          });
          if (handled) continue;
        }

        if (role === "media" && !botChatRole) continue;

        if (role === "main" && runtime.defaults.whatsappMainObserveOnly) {
          logThinking(runtime, {
            phase: "observe_only",
            userId,
            remoteJid,
            detail: "sessao principal: aprendizado sem resposta"
          });
          continue;
        }

        const activation = runtime.tetoActivation;
        if (!isGroup && activation?.isActivationRequired?.() && isOwnerContact(runtime, remoteJid, userId)) {
          if (!activation.isDmActive(userId)) {
            activation.activateDm(userId, { activatedBy: userId, autoOwner: true });
            logThinking(runtime, {
              phase: "activation_auto",
              userId,
              remoteJid,
              detail: "dona reconhecida — dm ativado automaticamente"
            });
          }
        }
        if (!isGroup && activation) {
          activation.touchDm(userId);
          const dmActive = activation.isDmActive(userId);
          if (!dmActive) {
            logThinking(runtime, {
              phase: "activation_blocked",
              userId,
              remoteJid,
              detail: "dm nao ativado — /teto-ativar"
            });
            continue;
          }
        }
        if (isGroup && activation && !activation.isGroupActive(remoteJid)) {
          logThinking(runtime, {
            phase: "activation_blocked",
            userId,
            remoteJid,
            detail: "grupo nao ativado — /teto-grupo-ativar"
          });
          continue;
        }

        if (!isFromMe) {
          logIncomingAudit(runtime, {
            remoteJid,
            userId,
            participantId,
            isGroup,
            text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
            links,
            media,
            quotedMessage,
            isReply: Boolean(stanzaId),
            isDirectMention: isGroup ? isDirect : false,
            mentionHint,
            closeDecision,
            messageId: incoming.key?.id ?? null,
            pushName
          });
        }

        if (isFromMe) {
          logOutgoingAudit(runtime, {
            remoteJid,
            userId,
            participantId,
            isGroup,
            text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
            links,
            media,
            quotedMessage,
            isReply: Boolean(stanzaId),
            isDirectMention: isGroup ? isDirect : false,
            mentionHint,
            closeDecision: "self_message",
            messageId: incoming.key?.id ?? null,
            pushName
          });
          const fromMeActorId = resolveOwnerActorId(runtime) || userId || "self";
          runtime.eventLedger?.append?.({
            eventType: "message.outgoing",
            actorId: fromMeActorId,
            userId: fromMeActorId,
            remoteJid,
            participantId,
            isGroup,
            isReply: Boolean(stanzaId),
            hasQuotedMessage: Boolean(quotedMessage),
            messageId: incoming.key?.id ?? null,
            mediaType: media?.type ?? null,
            contentClass: classifyContent(text),
            links
          });
          runtime.behaviorProfiler?.record?.({
            ts: new Date().toISOString(),
            eventType: "message.incoming",
            actorId: fromMeActorId,
            remoteJid,
            mediaType: media?.type ?? null,
            links
          });
          if (incoming.key?.id) {
            const isBotOwn =
              role === "media" || botChatRole || (role === "full" && runtime.defaults.replyEnabled);
            const outActorId = isBotOwn ? "teto" : fromMeActorId;
            messageSnapshotById.set(
              incoming.key.id,
              buildMessageSnapshot({
                messageId: incoming.key.id,
                remoteJid,
                actorId: outActorId,
                text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
                mediaType: media?.type ?? null,
                quotedMessage
              })
            );
            chatMessageIndex.append({
              channelId: remoteJid,
              messageId: incoming.key.id,
              actorId: outActorId,
              speakerName: isBotOwn ? "Teto" : pushName || null,
              text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
              isFromBot: isBotOwn,
              remoteJid,
              quotedMessageId: stanzaId
            });
          }
          continue;
        }

        runtime.logger?.log?.("whatsapp.incoming", {
          remoteJid,
          userId,
          sessionId,
          isGroup,
          hasQuotedMessage: Boolean(quotedMessage),
          mediaType: media?.type ?? null,
          messageId: incoming.key?.id ?? null
        });
        runtime.eventLedger?.append?.({
          eventType: "message.incoming",
          actorId: userId,
          userId,
          remoteJid,
          participantId,
          isGroup,
          isReply: Boolean(stanzaId),
          hasQuotedMessage: Boolean(quotedMessage),
          messageId: incoming.key?.id ?? null,
          mediaType: media?.type ?? null,
          contentClass: classifyContent(text),
          links,
          pushName: incoming.pushName ?? null
        });
        runtime.behaviorProfiler?.record?.({
          ts: new Date().toISOString(),
          eventType: "message.incoming",
          actorId: userId,
          remoteJid,
          mediaType: media?.type ?? null,
          links
        });
        if (incoming.key?.id) {
          messageSnapshotById.set(
            incoming.key.id,
            buildMessageSnapshot({
              messageId: incoming.key.id,
              remoteJid,
              actorId: userId,
              text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
              mediaType: media?.type ?? null,
              quotedMessage
            })
          );
          chatMessageIndex.append({
            channelId: remoteJid,
            messageId: incoming.key.id,
            actorId: userId,
            speakerName: pushName || null,
            text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
            isFromBot: false,
            remoteJid,
            quotedMessageId: stanzaId
          });
        }
        logThinking(runtime, {
          phase: "event_captured",
          userId,
          remoteJid,
          detail: `media=${media?.type ?? "none"} links=${links.length} class=${classifyContent(text)}`
        });
        runtime.metrics?.increment?.("whatsapp.incoming");
        if (media?.type) {
          runtime.metrics?.increment?.(`whatsapp.media.${media.type}`);
        }

        const effectiveMessage = text || media?.transcript || media?.caption || `[${media?.type ?? "media"}]`;

        const isOwner = isOwnerContact(runtime, remoteJid, userId);

        orchestrator?.scheduleIncoming({
          remoteJid,
          message: effectiveMessage,
          userId,
          sessionId,
          isOwner,
          channelId: remoteJid,
          isGroup,
          participants: (() => {
            const ch = runtime.channelRegistry.get(remoteJid);
            if (ch.participants?.length) return ch.participants;
            return isGroup && participantId ? [participantId] : [userId];
          })(),
          isDirectMention: isGroup ? isDirect : false,
          groupEngagementActive: isGroup ? groupEngagementActive : false,
          groupAddressKind: isGroup ? groupAddressKind : null,
          isReply: isReply || isReplyToBot,
          isReplyToBot,
          quotedMessage,
          quotedMessageId: stanzaId,
          replyThreadContext,
          media,
          closeDecision,
          messageKey: incoming.key ? { ...incoming.key } : undefined,
          pushName: pushName || null,
          participantId: isGroup ? participantId : null,
          participantJid: isGroup ? extractParticipant(incoming) || null : null,
          preferQuoteReply: true
        });
      } catch (error) {
        console.error("[whatsapp] message handler error:", error.message);
      }
    }
  });

  if (role !== "media" || botChatRole) {
    socket.ev.on("messages.update", (updates = []) => {
      for (const update of updates) {
        const messageId = update?.key?.id ?? null;
        const before = messageId ? messageSnapshotById.get(messageId) : null;
        const updatedText = extractUpdatedText(update);
        const isEdit = Boolean(updatedText && before && updatedText !== before.text);
        if (isEdit) {
          const reason = inferEditReason(before?.text, updatedText);
          if (runtime?.defaults?.thinkingLogsEnabled) {
            console.log(`[audit.edit] ${JSON.stringify({
              ts: new Date().toISOString(),
              messageId,
              remoteJid: update?.key?.remoteJid ?? null,
              actorId: before?.actorId ?? extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? ""),
              before: before?.text ?? null,
              after: updatedText,
              reason
            })}`);
          }
          runtime.eventLedger?.append?.({
            eventType: "message.edited",
            messageId,
            remoteJid: update?.key?.remoteJid ?? null,
            actorId: before?.actorId ?? extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? ""),
            beforeText: before?.text ?? null,
            afterText: updatedText,
            reason
          });
          messageSnapshotById.set(
            messageId,
            {
              ...before,
              text: updatedText,
              ts: new Date().toISOString()
            }
          );
        }
        if (runtime?.defaults?.thinkingLogsEnabled) {
          console.log(`[audit.update] ${JSON.stringify({
            ts: new Date().toISOString(),
            messageId,
            remoteJid: update?.key?.remoteJid ?? null,
            participant: update?.key?.participant ?? null,
            status: update?.update?.status ?? null
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "message.update",
          messageId,
          remoteJid: update?.key?.remoteJid ?? null,
          actorId: extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? "")
        });
        runtime.behaviorProfiler?.record?.({
          ts: new Date().toISOString(),
          eventType: "message.update",
          actorId: extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? ""),
          remoteJid: update?.key?.remoteJid ?? null
        });
      }
    });

    socket.ev.on("message-receipt.update", (updates = []) => {
      for (const update of updates) {
        if (runtime?.defaults?.thinkingLogsEnabled) {
          console.log(`[audit.receipt] ${JSON.stringify({
            ts: new Date().toISOString(),
            messageId: update?.key?.id ?? null,
            remoteJid: update?.key?.remoteJid ?? null,
            receipt: update?.receipt ?? null
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "message.receipt_update",
          messageId: update?.key?.id ?? null,
          remoteJid: update?.key?.remoteJid ?? null,
          receipt: update?.receipt ?? null
        });
      }
    });

    socket.ev.on("messages.reaction", (reactions = []) => {
      for (const reaction of reactions) {
        const actorId = extractPhone(reaction?.key?.participant ?? reaction?.key?.remoteJid ?? "");
        if (runtime?.defaults?.thinkingLogsEnabled) {
          console.log(`[audit.reaction] ${JSON.stringify({
            ts: new Date().toISOString(),
            actorId,
            remoteJid: reaction?.key?.remoteJid ?? null,
            messageId: reaction?.key?.id ?? null,
            reactionText: reaction?.reaction?.text ?? null
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "message.reaction",
          actorId,
          remoteJid: reaction?.key?.remoteJid ?? null,
          messageId: reaction?.key?.id ?? null,
          reactionText: reaction?.reaction?.text ?? null
        });
        runtime.behaviorProfiler?.record?.({
          ts: new Date().toISOString(),
          eventType: "message.reaction",
          actorId,
          remoteJid: reaction?.key?.remoteJid ?? null
        });
      }
    });
  }
}
