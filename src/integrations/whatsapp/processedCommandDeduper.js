const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

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
