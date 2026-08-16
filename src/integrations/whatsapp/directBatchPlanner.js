const MEDIA_HOLD_TYPES = new Set(["image", "sticker", "gif", "video", "audio"]);
const MEDIA_HOLD_CAP_MS = 12_000;
const TEXT_BATCH_MIN_MS = 400;
const TEXT_BATCH_MAX_MS = 700;
const POST_GEN_COALESCE_MS = 2500;

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
  const nextText = String(entry.message ?? entry.caption ?? "").trim();
  if (entry.media?.type && !previous.media?.type && prevText.length > 80) return true;
  const isolatedQuestion =
    !entry.media &&
    !previous.media &&
    /\?\s*$/.test(nextText) &&
    nextText.length >= 8 &&
    nextText.length <= 180 &&
    prevText.length > 60 &&
    !/\?/.test(prevText);
  if (isolatedQuestion) return true;
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
    return stillTyping ? Math.min(5500, POST_GEN_COALESCE_MS + 1500) : POST_GEN_COALESCE_MS;
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
  if (stillTyping) {
    return Math.min(5500, Math.round(Number(batchWindowMs) * 2.2));
  }
  const quiet = Math.round(Number(batchWindowMs) * 0.5);
  return Math.min(TEXT_BATCH_MAX_MS, Math.max(TEXT_BATCH_MIN_MS, quiet));
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

