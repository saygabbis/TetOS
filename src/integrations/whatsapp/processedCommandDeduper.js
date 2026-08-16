const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIVE_APPEND_MAX_AGE_MS = 120_000;

/**
 * append antigo = replay de histórico (reconnect). append recente = msg viva em grupo.
 */
export function isStaleHistoryReplay(type, incoming, now = Date.now(), maxAgeMs = DEFAULT_LIVE_APPEND_MAX_AGE_MS) {
  if (type !== "append") return false;
  const ts = Number(incoming?.messageTimestamp ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const ms = ts > 1e12 ? ts : ts * 1000;
  return now - ms > maxAgeMs;
}

/** Evita reprocessar o mesmo comando (.sticker etc.) após replay do Baileys/reconnect. */
export function createProcessedCommandDeduper(ttlMs = DEFAULT_TTL_MS) {
  const processed = new Map();

  function prune(now = Date.now()) {
    for (const [id, ts] of processed) {
      if (now - ts > ttlMs) processed.delete(id);
    }
  }

  /** false = comando desta messageId já foi processado nesta sessão. */
  function claim(messageId, now = Date.now()) {
    if (!messageId) return true;
    prune(now);
    if (processed.has(messageId)) return false;
    processed.set(messageId, now);
    return true;
  }

  return { claim, prune };
}
