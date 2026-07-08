function speakerLabel(entry = {}) {
  return entry.pushName || entry.userId || "alguém";
}

/**
 * Buffer de mensagens recebidas enquanto a Teto dorme — flush ao acordar.
 */
export class SleepMessageBuffer {
  constructor({ maxPerSession = 12 } = {}) {
    this.maxPerSession = maxPerSession;
    this.bySession = new Map();
  }

  append(sessionId, entry = {}) {
    const key = String(sessionId ?? "default");
    let buf = this.bySession.get(key) ?? { entries: [] };
    buf.entries.push({
      ...entry,
      ts: entry.ts ?? Date.now()
    });
    if (buf.entries.length > this.maxPerSession) {
      buf.entries = buf.entries.slice(-this.maxPerSession);
    }
    this.bySession.set(key, buf);
    return buf.entries.length;
  }

  peekCount(sessionId) {
    return this.bySession.get(String(sessionId ?? "default"))?.entries?.length ?? 0;
  }

  flush(sessionId) {
    const key = String(sessionId ?? "default");
    const buf = this.bySession.get(key);
    if (!buf?.entries?.length) return null;
    const entries = buf.entries;
    this.bySession.delete(key);
    return this.buildCatchUpEntry(entries);
  }

  buildCatchUpEntry(entries = []) {
    const list = entries.filter(Boolean);
    if (!list.length) return null;

    const last = list[list.length - 1];
    const singleSpeaker = new Set(list.map((e) => e.userId)).size <= 1;
    const message = singleSpeaker
      ? list.map((e) => String(e.message ?? "").trim()).filter(Boolean).join("\n")
      : list
          .map((e) => `[${speakerLabel(e)}]: ${String(e.message ?? "").trim()}`)
          .filter(Boolean)
          .join("\n");

    return {
      ...last,
      message,
      batchedCount: list.length,
      sleepCatchUp: true,
      sleepCatchUpCount: list.length,
      messageKey: last.messageKey,
      ts: last.ts ?? Date.now()
    };
  }
}
