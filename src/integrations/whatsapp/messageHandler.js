import { handleIncomingMessage } from "../../app/createRuntime.js";
import { jidNormalizedUser } from "baileys";
import { planWhatsAppReaction } from "./reactionPlanner.js";

function extractPhone(remoteJid = "") {
  return String(remoteJid).replace(/@.+$/, "");
}

function extractText(message = {}) {
  const viewOnce = message?.viewOnceMessage?.message;
  const ephemeral = message?.ephemeralMessage?.message;
  const wrapped = viewOnce ?? ephemeral;
  if (wrapped) return extractText(wrapped);

  return (
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption ??
    message?.buttonsResponseMessage?.selectedButtonId ??
    message?.listResponseMessage?.title ??
    ""
  );
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
const INTERRUPT_DEBOUNCE_MIN_MS = 220;
const INTERRUPT_DEBOUNCE_MAX_MS = 420;
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

  async function sendReplies(remoteJid, replies = [], token = 0, options = {}) {
    for (let index = 0; index < replies.length; index += 1) {
      const content = String(replies[index] ?? "").trim();
      if (!content) continue;
      if (interruptByUser.get(extractPhone(remoteJid)) !== token) return;
      const remotePhone = extractPhone(remoteJid);
      const len = content.length;
      let needsTyping;
      let typingDelayMs;
      if (index > 0) {
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
      if (interruptByUser.get(extractPhone(remoteJid)) !== token) return;
      console.log(`[whatsapp] outgoing ${remoteJid}: ${content}`);
      await socket.sendMessage(remoteJid, { text: content });
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
        let waitForTypingMs = Math.max(0, typingUntil - Date.now());
        if (waitForTypingMs > 0) {
          // Às vezes responde ainda com o usuário "digitando" (complementando várias bolhas) — mais raro.
          if (Math.random() < 0.14) {
            waitForTypingMs = Math.min(waitForTypingMs, randBetween(120, 420));
          } else if (Math.random() < 0.09) {
            waitForTypingMs = Math.floor(waitForTypingMs * 0.32);
          }
          await sleep(waitForTypingMs);
        }
        const debounceMs = randBetween(INTERRUPT_DEBOUNCE_MIN_MS, INTERRUPT_DEBOUNCE_MAX_MS);
        await sleep(debounceMs);
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
        console.log(`[whatsapp] generating reply for ${userId}…`);
        if (typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("composing", item.remoteJid);
          } catch (e) {
            console.warn(`[whatsapp] composing (during generation) failed: ${e.message}`);
          }
        }
        let replies = [];
        try {
          const out = await handleIncomingMessage(runtime, {
            message: item.message,
            userId: item.userId,
            sessionId: item.sessionId
          });
          replies = out?.replies ?? [];
        } finally {
          runtime.timeStore?.markSeen(item.userId);
          runtime.userPatterns?.recordInteraction(item.userId);
          if (typeof socket.sendPresenceUpdate === "function") {
            try {
              const hasOutgoing =
                Array.isArray(replies) && replies.some((r) => String(r ?? "").trim().length > 0);
              if (!hasOutgoing) {
                await socket.sendPresenceUpdate("paused", item.remoteJid);
              }
            } catch (_) {
              /* ignore */
            }
          }
        }
        if (interruptByUser.get(userId) !== token) continue;
        const plan = planWhatsAppReaction({
          userText: item.message,
          state: reactionState
        });
        if (plan.emoji && item.messageKey && typeof socket.sendMessage === "function") {
          try {
            await socket.sendMessage(item.remoteJid, {
              react: { text: plan.emoji, key: item.messageKey }
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
        await sendReplies(item.remoteJid, replies, token, { softened });
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
  socket.ev.on("presence.update", orchestrator.onPresenceUpdate);

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const incoming of messages ?? []) {
      try {
        if (!incoming?.message) continue;
        if (incoming.key?.fromMe) continue;

        const remoteJidRaw = incoming.key?.remoteJid ?? "";
        const remoteJid = jidNormalizedUser(remoteJidRaw);
        if (!remoteJid || remoteJid.endsWith("@broadcast") || remoteJid === "status@broadcast") {
          continue;
        }

        const isGroup = remoteJid.endsWith("@g.us");
        const text = extractText(incoming.message).trim();
        if (!text) continue;
        console.log(`[whatsapp] incoming ${remoteJid}: ${text}`);

        const userId = extractPhone(remoteJid);
        orchestrator.bumpInterrupt(userId);
        orchestrator.clearTypingGrace(userId);
        const sessionId = `wa-${userId}`;
        const profile = runtime.longTerm.getProfile(userId);
        const pushName = incoming.pushName?.trim();

        if (pushName) {
          runtime.longTerm.updateProfile(userId, {
            facts: { ...(profile?.facts ?? {}), name: pushName }
          });
        }

        if (isGroup) {
          const mentionHint = incoming.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
          const hasMention = mentionHint.includes(remoteJid) || mentionHint.includes(`${userId}@s.whatsapp.net`);
          const hasNickname = /(teto|tete|tetozinha)/i.test(text);
          const isDirect = hasMention || hasNickname || /\?\s*$/.test(text);
          if (!isDirect) {
            continue;
          }
        }

        orchestrator.scheduleIncoming({
          remoteJid,
          message: text,
          userId,
          sessionId,
          messageKey: incoming.key ? { ...incoming.key } : undefined
        });
      } catch (error) {
        console.error("[whatsapp] message handler error:", error.message);
      }
    }
  });
}
