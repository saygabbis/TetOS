const MEDIA_HOLD_TYPES = new Set(["image", "sticker", "gif", "video", "audio"]);
const MEDIA_HOLD_CAP_MS = 12_000;
const POST_GEN_COALESCE_MS = 2500;
/** Enquanto a pessoa digita, a fila reconfere nesse intervalo em vez de responder. */
export const TYPING_RECHECK_MS = 1500;
/** Teto de espera de uma rajada (a partir da 1ª msg) — ninguém fica sem resposta digitando sem parar. */
export const DM_BURST_MAX_MS = 25_000;
export const GROUP_BURST_MAX_MS = 15_000;

/** Termina "pendurada" (vírgula, conectivo, artigo…): quase certo que vem mais mensagem. */
const TRAILING_CONNECTIVE =
  /(?:,|:|\.\.\.|…|(?<![\p{L}])(?:e|mas|por(?:que|q)|pq|que|q|tipo|ent[aã]o|a[ií]|da[ií]|ou|de|do|da|pra|pro|com|o|a|os|as|um|uma|meu|minha|se|quando|tipo assim|sabe|n[eé]))\s*$/iu;
const LAUGH_OR_EMOJI_END = /(?:k{2,}|rs+|ha(?:ha)+|[\u{1F300}-\u{1FAFF}\u2600-\u27BF])\s*$/iu;

/**
 * Quanto esperar em silêncio depois da última mensagem antes de responder a rajada.
 * Antes era 0,4–0,7 s: a 2ª bolha de quem digita em partes sempre chegava com a resposta já saindo.
 */
export function textSettleMs(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return 2600;
  if (TRAILING_CONNECTIVE.test(t)) return 4500;
  if (/[?!.]\s*$/.test(t) || LAUGH_OR_EMOJI_END.test(t) || t.length >= 120) return 1600;
  return 2600;
}

export function isMediaHoldEntry(entry = {}) {
  return MEDIA_HOLD_TYPES.has(entry?.media?.type);
}

export function shouldFlushPendingOnIncoming(previous, entry) {
  if (!previous || !entry) return false;
  return Boolean(
    entry.isReply &&
      previous.quotedMessageId &&
      entry.quotedMessageId &&
      previous.quotedMessageId !== entry.quotedMessageId
  );
}

export function shouldSplitBurst(previous, entry) {
  if (!previous || !entry) return false;
  if (shouldFlushPendingOnIncoming(previous, entry)) return true;
  const prevPath = previous.media?.path;
  const nextPath = entry.media?.path;
  if (prevPath && nextPath && prevPath !== nextPath) return true;
  const prevText = String(previous.message ?? previous.caption ?? "").trim();
  if (entry.media?.type && !previous.media?.type && prevText.length > 80) return true;
  // (Removido: separar "pergunta isolada" depois de texto longo — fazia a Teto responder bolha por bolha.)
  return false;
}

export function computeDirectBatchMs(
  entry = {},
  previous = null,
  {
    stillTyping = false,
    batchWindowMs = 1200,
    mediaHoldMs = 5000,
    now = Date.now()
  } = {}
) {
  if (entry._coalesceAfterGen) {
    return stillTyping ? TYPING_RECHECK_MS : POST_GEN_COALESCE_MS;
  }
  const hold = isMediaHoldEntry(entry) || isMediaHoldEntry(previous);
  if (hold) {
    const started = previous?.mediaHoldStartedAt ?? entry.mediaHoldStartedAt ?? now;
    const elapsed = Math.max(0, now - started);
    const remainingCap = Math.max(0, MEDIA_HOLD_CAP_MS - elapsed);
    const remainingHold = mediaHoldMs - elapsed;
    if (stillTyping) {
      if (remainingCap <= 0) return 0;
      return Math.max(400, Math.min(remainingCap, Math.max(remainingHold, 800)));
    }
    return Math.max(0, Math.min(remainingCap, remainingHold));
  }
  if (stillTyping) return TYPING_RECHECK_MS;
  return textSettleMs(entry.message ?? entry.caption ?? "");
}

export function stampMediaHoldStart(previous, entry, now = Date.now()) {
  if (previous?.mediaHoldStartedAt) return previous.mediaHoldStartedAt;
  if (isMediaHoldEntry(previous) || isMediaHoldEntry(entry)) {
    return previous?.mediaHoldStartedAt ?? entry.mediaHoldStartedAt ?? now;
  }
  return undefined;
}

export function shouldSkipThinkDelaySleep(meta = {}) {
  if (meta.sleepGroggy || meta.sleepTemporarilyAwake || meta.sleepDisturbedWake) return false;
  const reasons = meta.timingPlan?.reasons ?? [];
  if (reasons.includes("just_woke_up") || reasons.includes("disturbed_wake") || reasons.includes("groggy")) {
    return false;
  }
  if (meta.isGroup) {
    return Boolean(meta.isDirectMention || meta.isReplyToBot);
  }
  return true;
}

export function thinkDelaySleepMs(meta = {}) {
  if (shouldSkipThinkDelaySleep(meta)) return 0;
  const thinkDelay = Number(meta?.timingPlan?.thinkDelayMs ?? 0);
  if (thinkDelay > 0 && thinkDelay < 8000) return Math.min(thinkDelay, 3000);
  return 0;
}

export function firstBubbleTypingFloorMs(cfg = {}, options = {}) {
  const base = cfg.firstBubbleTypingFloorMs ?? 480;
  const groggy = Boolean(options.sleepGroggy || options.sleepTemporarilyAwake);
  if (!options.isGroup && (options.batchedCount ?? 1) === 1 && !groggy) {
    return Math.min(base, 180);
  }
  return base;
}

export function visionFlushTimeoutMs(item = {}, now = Date.now()) {
  const started = item.mediaHoldStartedAt ?? item.ts ?? now;
  const leftover = 5000 - (now - started);
  return Math.max(2000, Math.min(8000, leftover > 0 ? leftover + 2000 : 8000));
}

export function abortPendingHoldStores(
  stores = {},
  { sessionId, remoteJid } = {}
) {
  let aborted = false;
  if (sessionId && stores.pendingBySession) {
    const pending = stores.pendingBySession.get(sessionId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
      stores.pendingBySession.delete(sessionId);
      aborted = true;
    } else if (pending) {
      stores.pendingBySession.delete(sessionId);
      aborted = true;
    }
  }
  if (sessionId && stores.deferredBySession) {
    const deferred = stores.deferredBySession.get(sessionId);
    if (deferred) {
      if (deferred.timer) clearTimeout(deferred.timer);
      stores.deferredBySession.delete(sessionId);
      aborted = true;
    }
  }
  if (remoteJid && stores.pendingByGroupChannel) {
    const pendingGroup = stores.pendingByGroupChannel.get(remoteJid);
    if (pendingGroup?.timer) {
      clearTimeout(pendingGroup.timer);
      stores.pendingByGroupChannel.delete(remoteJid);
      aborted = true;
    } else if (pendingGroup) {
      stores.pendingByGroupChannel.delete(remoteJid);
      aborted = true;
    }
  }
  return aborted;
}

