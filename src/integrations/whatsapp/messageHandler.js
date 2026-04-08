import { handleIncomingMessage } from "../../app/createRuntime.js";
import { jidNormalizedUser } from "baileys";

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

const USER_BATCH_WINDOW_MS = 900;
const USER_TYPING_GRACE_MS = 1800;
const TYPING_MIN_DELAY_MS = 900;
const TYPING_MAX_DELAY_MS = 4200;
const TYPING_CHARS_PER_SECOND = 10;

function estimateTypingDelayMs(text) {
  const length = Math.max(1, String(text ?? "").length);
  const estimate = (length / TYPING_CHARS_PER_SECOND) * 1000;
  return Math.max(TYPING_MIN_DELAY_MS, Math.min(TYPING_MAX_DELAY_MS, estimate));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createConversationOrchestrator(socket, runtime) {
  const pendingByUser = new Map();
  const queueByUser = new Map();
  const runningByUser = new Set();
  const typingByUser = new Map();

  async function sendReplies(remoteJid, replies = []) {
    for (let index = 0; index < replies.length; index += 1) {
      const content = String(replies[index] ?? "").trim();
      if (!content) continue;
      const remotePhone = extractPhone(remoteJid);
      const isFollowUpPart = index > 0;
      const needsTyping = isFollowUpPart || content.length > 35;
      if (needsTyping && typeof socket.sendPresenceUpdate === "function") {
        try {
          await socket.sendPresenceUpdate("composing", remoteJid);
          await sleep(estimateTypingDelayMs(content));
          await socket.sendPresenceUpdate("paused", remoteJid);
        } catch (error) {
          console.warn(`[whatsapp] typing simulation failed for ${remotePhone}: ${error.message}`);
        }
      }
      console.log(`[whatsapp] outgoing ${remoteJid}: ${content}`);
      await socket.sendMessage(remoteJid, { text: content });
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
        const waitForTypingMs = typingUntil - Date.now();
        if (waitForTypingMs > 0) {
          await sleep(waitForTypingMs);
        }
        const { replies } = await handleIncomingMessage(runtime, {
          message: item.message,
          userId: item.userId,
          sessionId: item.sessionId
        });
        await sendReplies(item.remoteJid, replies);
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
          message: `${previous.message}\n${entry.message}`.trim()
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

  return { scheduleIncoming, onPresenceUpdate };
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

        const text = extractText(incoming.message).trim();
        if (!text) continue;
        console.log(`[whatsapp] incoming ${remoteJid}: ${text}`);

        const userId = extractPhone(remoteJid);
        const sessionId = `wa-${userId}`;
        const profile = runtime.longTerm.getProfile(userId);
        const pushName = incoming.pushName?.trim();

        if (pushName) {
          runtime.longTerm.updateProfile(userId, {
            facts: { ...(profile?.facts ?? {}), name: pushName }
          });
        }

        orchestrator.scheduleIncoming({
          remoteJid,
          message: text,
          userId,
          sessionId
        });
      } catch (error) {
        console.error("[whatsapp] message handler error:", error.message);
      }
    }
  });
}
