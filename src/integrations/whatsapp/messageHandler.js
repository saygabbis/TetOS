import { handleIncomingMessage } from "../../app/createRuntime.js";
import { jidNormalizedUser, downloadContentFromMessage } from "baileys";
import { planWhatsAppReaction } from "./reactionPlanner.js";
import { persistMedia } from "./mediaStore.js";
import { resolvePassiveModeAction } from "../../core/channels/passiveModeAction.js";
import { resolveStickerAsset } from "./stickerAssets.js";
import { ChatService } from "../../modules/chat/chatService.js";

function extractPhone(remoteJid = "") {
  return String(remoteJid).replace(/@.+$/, "");
}

function unwrapMessage(message = {}) {
  const viewOnce = message?.viewOnceMessage?.message;
  const ephemeral = message?.ephemeralMessage?.message;
  const wrapped = viewOnce ?? ephemeral;
  if (wrapped) return unwrapMessage(wrapped);
  return message;
}

function extractText(message = {}) {
  const unwrapped = unwrapMessage(message);
  return (
    unwrapped?.conversation ??
    unwrapped?.extendedTextMessage?.text ??
    unwrapped?.imageMessage?.caption ??
    unwrapped?.videoMessage?.caption ??
    unwrapped?.stickerMessage?.fileName ??
    unwrapped?.buttonsResponseMessage?.selectedButtonId ??
    unwrapped?.listResponseMessage?.title ??
    ""
  );
}

function extractParticipant(incoming) {
  const participant =
    incoming?.key?.participantPn ??
    incoming?.participantPn ??
    incoming?.key?.participant ??
    incoming?.participant ??
    "";
  return jidNormalizedUser(participant);
}

const USER_BATCH_WINDOW_MS = 650;
/** Tende a esperar o usuário parar de "composing" antes de gerar resposta (multi-msg). */
const USER_TYPING_GRACE_MS = 2400;
/** Pausa "digitando": visível o suficiente; sobe com √tamanho + variação por bolha. */
const TYPING_MIN_DELAY_MS = 140;
const TYPING_MAX_DELAY_MS = 2400;
const TYPING_SQRT_REF_LEN = 220;
const MULTI_PART_DELAY_MIN_MS = 120;
const MULTI_PART_DELAY_MAX_MS = 380;
/** Piso na 1ª bolha quando mostramos composing só no envio (acks ultra curtos sem composing). */
const FIRST_BUBBLE_TYPING_FLOOR_MS = 480;
/** Pequena pausa entre soltar "paused" pós-modelo e recomposing da 1ª bolha (mais natural). */
const POST_MODEL_BEFORE_BUBBLE_MS_MIN = 90;
const POST_MODEL_BEFORE_BUBBLE_MS_MAX = 240;
const INTERRUPT_DEBOUNCE_MIN_MS = 120;
const INTERRUPT_DEBOUNCE_MAX_MS = 260;
const MODEL_TIMEOUT_MS = 25000;
function estimateTypingDelayMs(text, partIndex = 0) {
  const len = String(text ?? "").trim().length;
  if (len <= 0) return TYPING_MIN_DELAY_MS;
  const span = TYPING_MAX_DELAY_MS - TYPING_MIN_DELAY_MS;
  const ratio = Math.sqrt(len) / Math.sqrt(TYPING_SQRT_REF_LEN);
  const blended = TYPING_MIN_DELAY_MS + Math.min(1, ratio) * span;
  const partWave = 1 + (partIndex % 2 === 0 ? 0.05 : 0.14);
  const jitter = 0.82 + Math.random() * 0.34;
  const ms = blended * partWave * jitter;
  return Math.round(Math.min(TYPING_MAX_DELAY_MS, Math.max(TYPING_MIN_DELAY_MS, ms)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function createConversationOrchestrator(socket, runtime) {
  const pendingByUser = new Map();
  const queueByUser = new Map();
  const runningByUser = new Set();
  const typingByUser = new Map();
  const interruptByUser = new Map();
  /** @type {Map<string, { messagesSinceLastReaction: number, lastReactionAt: number }>} */
  const reactionStateByUser = new Map();

  async function sendReplies(remoteJid, userId, replies = [], token = 0, options = {}) {
    for (let index = 0; index < replies.length; index += 1) {
      const content = String(replies[index] ?? "").trim();
      if (!content) continue;
      if (interruptByUser.get(userId) !== token) return;
      const remotePhone = extractPhone(remoteJid);
      const len = content.length;
      const isGroup = remoteJid.endsWith("@g.us");
      let needsTyping;
      let typingDelayMs;
      if (isGroup) {
        needsTyping = false;
        typingDelayMs = 0;
      } else if (index > 0) {
        needsTyping = true;
        typingDelayMs = estimateTypingDelayMs(content, index);
      } else if (len <= 4) {
        needsTyping = false;
        typingDelayMs = 0;
      } else {
        needsTyping = true;
        const base = estimateTypingDelayMs(content, index);
        const extraDelay = options?.softened ? randBetween(120, 320) : 0;
        typingDelayMs = Math.min(
          TYPING_MAX_DELAY_MS,
          Math.max(FIRST_BUBBLE_TYPING_FLOOR_MS, base + extraDelay)
        );
      }
      if (index === 0 && needsTyping && typingDelayMs > 0) {
        await sleep(randBetween(POST_MODEL_BEFORE_BUBBLE_MS_MIN, POST_MODEL_BEFORE_BUBBLE_MS_MAX));
      }
      if (needsTyping && typingDelayMs > 0 && typeof socket.sendPresenceUpdate === "function") {
        try {
          await socket.sendPresenceUpdate("composing", remoteJid);
          await sleep(typingDelayMs);
          await socket.sendPresenceUpdate("paused", remoteJid);
        } catch (error) {
          console.warn(`[whatsapp] typing simulation failed for ${remotePhone}: ${error.message}`);
        }
      }
      if (interruptByUser.get(userId) !== token) {
        return;
      }
      console.log(`[whatsapp] outgoing ${remoteJid}: ${content}`);
      const sendTask = socket.sendMessage(remoteJid, { text: content });
      await Promise.race([
        sendTask,
        new Promise((_, reject) => setTimeout(() => reject(new Error("send timeout")), 8000))
      ]).catch((error) => {
        console.error(`[whatsapp] send failed to ${remoteJid}:`, error.message);
      });
      if (index < replies.length - 1) {
        const interPartDelayMs = randBetween(MULTI_PART_DELAY_MIN_MS, MULTI_PART_DELAY_MAX_MS);
        await sleep(interPartDelayMs);
      }
    }
  }

  async function drainUserQueue(userId) {
    if (runningByUser.has(userId)) return;
    runningByUser.add(userId);
    try {
      while (queueByUser.get(userId)?.length) {
        const item = queueByUser.get(userId).shift();
        if (!item) continue;
        const typingUntil = typingByUser.get(userId) ?? 0;
        const token = Date.now();
        interruptByUser.set(userId, token);
        const prevR = reactionStateByUser.get(userId) ?? {
          messagesSinceLastReaction: 10,
          lastReactionAt: 0
        };
        const reactionState = {
          messagesSinceLastReaction: (prevR.messagesSinceLastReaction ?? 0) + 1,
          lastReactionAt: prevR.lastReactionAt ?? 0
        };
        let replies = [];
        if (item.closeDecision === "respond") {
          console.log(`[whatsapp] generating reply for ${userId}…`);
          if (typeof socket.sendPresenceUpdate === "function") {
            try {
              await socket.sendPresenceUpdate("composing", item.remoteJid);
            } catch (e) {
              console.warn(`[whatsapp] composing (during generation) failed: ${e.message}`);
            }
          }
        }
        try {
          const out = await Promise.race([
            handleIncomingMessage(runtime, {
              message: item.message,
              userId: item.userId,
              sessionId: item.sessionId,
              channelId: item.channelId,
              isGroup: item.isGroup,
              participants: item.participants,
              isDirectMention: item.isDirectMention,
              isReply: item.isReply,
              quotedMessage: item.quotedMessage,
              messageKey: item.messageKey,
              closeDecision: item.closeDecision
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("model timeout")), MODEL_TIMEOUT_MS)
            )
          ]);

          replies = out?.replies ?? [];
          item.passiveMode = out?.policy?.mode ?? "full";
          if (item.passiveMode === "react_only") {
            replies = [];
          }
        } catch (error) {
          console.error(`[whatsapp] generation error for ${item.userId}:`, error.message);
          replies = [];
        }

        const hasOutgoing =
          Array.isArray(replies) && replies.some((r) => String(r ?? "").trim().length > 0);
        if (hasOutgoing && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("composing", item.remoteJid);
          } catch (e) {
            console.warn(`[whatsapp] composing (during generation) failed: ${e.message}`);
          }
        }

        runtime.timeStore?.markSeen(item.userId);
        runtime.userPatterns?.recordInteraction(item.userId);
        if (!hasOutgoing && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("paused", item.remoteJid);
          } catch (_) {
            /* ignore */
          }
        }
        if (interruptByUser.get(userId) !== token) continue;
        const passiveAction = resolvePassiveModeAction({
          policy: { allowed: true, mode: item.passiveMode },
          media: item.media,
          isGroup: item.isGroup
        });

        const plan = planWhatsAppReaction({
          userText: item.message,
          state: reactionState
        });
        const forcedReaction = item.closeDecision === "react" || passiveAction.type === "react_only" ? "❤️" : null;
        const emoji = plan.emoji ?? forcedReaction;
        const reacted = Boolean(emoji && item.messageKey && typeof socket.sendMessage === "function");
        if (reacted) {
          try {
            await socket.sendMessage(item.remoteJid, {
              react: { text: emoji, key: item.messageKey }
            });
            reactionStateByUser.set(userId, {
              messagesSinceLastReaction: 0,
              lastReactionAt: Date.now()
            });
          } catch (e) {
            console.warn(`[whatsapp] reaction failed: ${e.message}`);
            reactionStateByUser.set(userId, {
              ...reactionState,
              lastReactionAt: reactionState.lastReactionAt
            });
          }
        } else {
          reactionStateByUser.set(userId, {
            messagesSinceLastReaction: reactionState.messagesSinceLastReaction,
            lastReactionAt: reactionState.lastReactionAt
          });
        }
        const softened = runtime.userPatterns
          ? !runtime.userPatterns.isLikelyActiveNow(item.userId)
          : false;
        if (!reacted && passiveAction.type === "sticker_only") {
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

        if (!reacted) {
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
            const debounceMs = randBetween(INTERRUPT_DEBOUNCE_MIN_MS, INTERRUPT_DEBOUNCE_MAX_MS);
            await sleep(debounceMs);
          }
          await sendReplies(item.remoteJid, item.userId, replies, token, { softened });
        }
      }
    } finally {
      runningByUser.delete(userId);
    }
  }

  function enqueue(entry) {
    const queue = queueByUser.get(entry.userId) ?? [];
    queue.push(entry);
    queueByUser.set(entry.userId, queue);
    drainUserQueue(entry.userId).catch((error) => {
      console.error("[whatsapp] queue processing error:", error.message);
    });
  }

  function scheduleIncoming(entry) {
    const previous = pendingByUser.get(entry.userId);
    if (previous?.timer) clearTimeout(previous.timer);
    const merged = previous
      ? {
          ...entry,
          message: `${previous.message}\n${entry.message}`.trim(),
          messageKey: entry.messageKey ?? previous.messageKey
        }
      : entry;
    const timer = setTimeout(() => {
      pendingByUser.delete(entry.userId);
      enqueue(merged);
    }, USER_BATCH_WINDOW_MS);
    pendingByUser.set(entry.userId, { ...merged, timer });
  }

  function onPresenceUpdate(update = {}) {
    const id = jidNormalizedUser(update?.id ?? "");
    const userId = extractPhone(id);
    if (!userId) return;
    const presences = update?.presences ?? {};
    const userPresence = presences[id] ?? presences[`${userId}@s.whatsapp.net`] ?? null;
    const isTyping = userPresence?.lastKnownPresence === "composing";
    if (isTyping) {
      typingByUser.set(userId, Date.now() + USER_TYPING_GRACE_MS);
    }
  }


  /** Invalidate in-flight replies when user sends a new message (must stay inside closure). */
  function bumpInterrupt(userId) {
    interruptByUser.set(userId, Date.now());
  }

  /** Já recebemos o texto — não esperar grace de "composing" do turno anterior (evita +atraso antes do modelo). */
  function clearTypingGrace(userId) {
    typingByUser.delete(userId);
  }

  return { scheduleIncoming, onPresenceUpdate, bumpInterrupt, clearTypingGrace };
}

export function registerMessageHandler({ socket, runtime }) {
  const orchestrator = createConversationOrchestrator(socket, runtime);
  const groupContextByUser = new Map();
  const GROUP_CONTEXT_WINDOW_MS = 5 * 60 * 1000;
  const seenMessageIds = new Map();
  const MESSAGE_DEDUPE_TTL_MS = 60 * 1000;
  socket.ev.on("presence.update", orchestrator.onPresenceUpdate);

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const incoming of messages ?? []) {
      try {
        if (!incoming?.message) continue;
        if (incoming.key?.fromMe) continue;
        if (incoming?.messageStubType && !incoming.message?.conversation) {
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
        const text = extractText(unwrappedMessage).trim();
        const hasMediaPayload = Boolean(
          unwrappedMessage?.imageMessage ||
          unwrappedMessage?.videoMessage ||
          unwrappedMessage?.audioMessage ||
          unwrappedMessage?.stickerMessage
        );
        if (!text && !hasMediaPayload) continue;
        console.log(`[whatsapp] incoming ${remoteJid}: ${text || "[media]"}`);

        const baseUserId = extractPhone(remoteJid);
        const participantId = isGroup ? extractPhone(extractParticipant(incoming)) : "";
        if (isGroup && !participantId) {
          continue;
        }
        const userId = isGroup ? participantId : baseUserId;
        const sessionId = isGroup && participantId ? `wa-group:${baseUserId}:${participantId}` : `wa-${baseUserId}`;

        const historySnapshot = runtime.shortTerm.getAll(sessionId);
        const closeDecision = ChatService.decideClosure(text, historySnapshot);

        orchestrator.bumpInterrupt(userId);
        orchestrator.clearTypingGrace(userId);
        const profile = runtime.longTerm.getProfile(userId);
        const pushName = incoming.pushName?.trim();

        if (pushName) {
          runtime.longTerm.updateProfile(userId, {
            facts: { ...(profile?.facts ?? {}), name: pushName }
          });
        }

        runtime.longTerm.updateProfile(userId, {
          facts: { ...(profile?.facts ?? {}), lastChannel: isGroup ? "group" : "direct" }
        });

        if (isGroup) {
          const mentionHint = incoming.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
          const botJid = jidNormalizedUser(socket?.user?.id ?? socket?.user?.jid ?? "");
          const botPhone = extractPhone(botJid);
          const hasMention =
            mentionHint.includes(botJid) ||
            mentionHint.includes(`${botPhone}@s.whatsapp.net`) ||
            mentionHint.includes(`${botPhone}@lid`) ||
            mentionHint.includes(`${botPhone}@c.us`);
          const hasNickname = /(teto|tete|tetozinha)/i.test(text);
          const isDirect = hasMention || hasNickname;
          const contextKey = `${baseUserId}:${participantId}`;
          const lastContextAt = groupContextByUser.get(contextKey) ?? 0;
          const inContext = Date.now() - lastContextAt <= GROUP_CONTEXT_WINDOW_MS;
          if (!isDirect && !inContext) {
            continue;
          }
          groupContextByUser.set(contextKey, Date.now());
        }

        const quotedMessage = unwrappedMessage?.extendedTextMessage?.contextInfo?.quotedMessage
          ? extractText(unwrappedMessage.extendedTextMessage.contextInfo.quotedMessage).trim()
          : "";

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
            const visualDescription = await runtime.semanticVisionAnalyzer?.analyze?.({
              filePath: path,
              mediaType: "image"
            }) ?? await runtime.visualAnalyzer?.analyze?.({
              filePath: path,
              mediaType: "image"
            });
            if (visualDescription) {
              runtime.visualAnalyses?.save?.({
                userId,
                channelId: remoteJid,
                mediaPath: path,
                mediaType: "image",
                description: visualDescription
              });
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
            const transcript = await runtime.audioTranscriber?.transcribe?.({
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
            const visualDescription = await runtime.semanticVisionAnalyzer?.analyze?.({
              filePath: path,
              mediaType: "sticker",
              isAnimated
            }) ?? await runtime.visualAnalyzer?.analyze?.({
              filePath: path,
              mediaType: "sticker",
              isAnimated
            });
            if (visualDescription) {
              runtime.visualAnalyses?.save?.({
                userId,
                channelId: remoteJid,
                mediaPath: path,
                mediaType: "sticker",
                description: visualDescription
              });
            }
            media = {
              type: "sticker",
              caption: text,
              transcript: visualDescription,
              isAnimated,
              path
            };
          }
        } catch (error) {
          runtime.logger?.log?.("whatsapp.media_error", {
            messageId: incoming.key?.id ?? null,
            error: error.message
          });
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
        runtime.metrics?.increment?.("whatsapp.incoming");
        if (media?.type) {
          runtime.metrics?.increment?.(`whatsapp.media.${media.type}`);
        }

        const effectiveMessage = text || media?.transcript || media?.caption || `[${media?.type ?? "media"}]`;

        orchestrator.scheduleIncoming({
          remoteJid,
          message: effectiveMessage,
          userId,
          sessionId,
          channelId: remoteJid,
          isGroup,
          participants: isGroup ? [baseUserId, participantId].filter(Boolean) : [userId],
          isDirectMention: isGroup ? isDirect : false,
          isReply: Boolean(unwrappedMessage?.extendedTextMessage?.contextInfo?.stanzaId),
          quotedMessage,
          media,
          closeDecision,
          messageKey: incoming.key ? { ...incoming.key } : undefined
        });
      } catch (error) {
        console.error("[whatsapp] message handler error:", error.message);
      }
    }
  });
}
