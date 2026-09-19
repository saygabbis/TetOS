import { randomBytes } from "node:crypto";

export const SEND_TIMEOUT_MS = 8000;
export const SEND_HANG_WAIT_MS = 12000;
export const OUTBOUND_DEDUPE_MS = 20_000;
const RECENT_STORE_MAX = 240;

export function createOutboundMessageId() {
  return `3EB0${randomBytes(16).toString("hex").toUpperCase().slice(0, 18)}`;
}

export function outboundDedupeKey(remoteJid, text) {
  return `${String(remoteJid ?? "").trim()}:${String(text ?? "").trim().toLowerCase()}`;
}

export function pruneRecentOutbound(store, now = Date.now(), ttlMs = OUTBOUND_DEDUPE_MS) {
  if (!store || typeof store.entries !== "function") return store;
  for (const [key, ts] of store.entries()) {
    if (!Number.isFinite(ts) || now - ts > ttlMs) store.delete(key);
  }
  return store;
}

export function claimOutboundDedupe(
  store,
  remoteJid,
  text,
  { now = Date.now(), ttlMs = OUTBOUND_DEDUPE_MS } = {}
) {
  if (!store || typeof store.get !== "function") return true;
  const key = outboundDedupeKey(remoteJid, text);
  if (!String(text ?? "").trim()) return true;
  if (store.size > RECENT_STORE_MAX) pruneRecentOutbound(store, now, ttlMs);
  const last = store.get(key);
  if (Number.isFinite(last) && now - last < ttlMs) return false;
  store.set(key, now);
  return true;
}

export function releaseOutboundDedupe(store, remoteJid, text) {
  if (!store || typeof store.delete !== "function") return;
  store.delete(outboundDedupeKey(remoteJid, text));
}

export function isSendTimeoutError(error) {
  return /send timeout/i.test(String(error?.message ?? error ?? ""));
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Dispara o envio uma vez. Timeout NÃO começa um segundo send —
 * espera o original (que o Baileys pode ter entregue mesmo com a promise lenta).
 * Retry só em erro de conexão, com a mesma `retrySend` (mesmo messageId).
 */
export async function awaitSendOnce({
  send,
  retrySend = null,
  isConnectionError = () => false,
  timeoutMs = SEND_TIMEOUT_MS,
  hangWaitMs = SEND_HANG_WAIT_MS,
  onTimeout = null,
  onRetry = null
} = {}) {
  if (typeof send !== "function") {
    throw new Error("awaitSendOnce requires send()");
  }
  const sendTask = Promise.resolve().then(() => send());
  try {
    return await withTimeout(sendTask, timeoutMs, "send timeout");
  } catch (error) {
    if (isSendTimeoutError(error)) {
      onTimeout?.(error);
      try {
        return await withTimeout(sendTask, hangWaitMs, "send timeout");
      } catch {
        return null;
      }
    }
    if (typeof retrySend === "function" && isConnectionError(error)) {
      onRetry?.(error);
      return retrySend();
    }
    throw error;
  }
}
