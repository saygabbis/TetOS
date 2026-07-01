/** Índice em memória das últimas mensagens por chat — quotes, thread e reply-to-bot. */
export class ChatMessageIndex {
  constructor({ maxPerChannel = 80 } = {}) {
    this.maxPerChannel = Math.max(20, Number(maxPerChannel) || 80);
    /** @type {Map<string, object[]>} */
    this.byChannel = new Map();
    /** @type {Map<string, object>} */
    this.byKey = new Map();
  }

  channelMessageKey(channelId, messageId) {
    return `${String(channelId ?? "")}:${String(messageId ?? "")}`;
  }

  append({
    channelId,
    messageId,
    actorId,
    speakerName = null,
    text = "",
    isFromBot = false,
    remoteJid = null,
    quotedMessageId = null,
    participantJid = null,
    ts = null
  } = {}) {
    if (!channelId || !messageId) return null;
    const entry = {
      channelId: String(channelId),
      messageId: String(messageId),
      actorId: actorId ?? null,
      speakerName: speakerName ?? null,
      text: String(text ?? "").slice(0, 600),
      isFromBot: Boolean(isFromBot),
      remoteJid: remoteJid ?? channelId,
      quotedMessageId: quotedMessageId ?? null,
      participantJid: participantJid ?? null,
      ts: ts ?? new Date().toISOString()
    };
    const list = this.byChannel.get(entry.channelId) ?? [];
    const dupIdx = list.findIndex((row) => row.messageId === entry.messageId);
    if (dupIdx >= 0) {
      list[dupIdx] = { ...list[dupIdx], ...entry };
    } else {
      list.push(entry);
    }
    if (list.length > this.maxPerChannel) {
      list.splice(0, list.length - this.maxPerChannel);
    }
    this.byChannel.set(entry.channelId, list);
    this.byKey.set(this.channelMessageKey(entry.channelId, entry.messageId), entry);
    return entry;
  }

  get(channelId, messageId) {
    if (!channelId || !messageId) return null;
    return this.byKey.get(this.channelMessageKey(channelId, messageId)) ?? null;
  }

  getThread(channelId, limit = 50) {
    const list = this.byChannel.get(String(channelId ?? "")) ?? [];
    return list.slice(-Math.max(1, Number(limit) || 50));
  }

  /** Converte user id numérico (erro do LLM) no message id mais recente daquela pessoa. */
  resolveQuoteMessageId(channelId, quoteId) {
    const raw = String(quoteId ?? "")
      .trim()
      .replace(/^\[?ID:\s*/i, "")
      .replace(/\]$/, "")
      .trim();
    if (!raw) return null;
    if (this.get(channelId, raw)) return raw;
    if (/^[0-9A-F]{12,}$/i.test(raw) && /[A-F]/i.test(raw)) return raw;
    if (!/^\d{10,}$/.test(raw)) return raw;
    const thread = this.getThread(channelId, 60);
    for (let i = thread.length - 1; i >= 0; i -= 1) {
      const row = thread[i];
      if (row?.isFromBot || row?.actorId === "teto") continue;
      if (String(row.actorId ?? "") === raw) return row.messageId;
    }
    return raw;
  }

  findBotMessageByText(channelId, quotedText = "") {
    const needle = String(quotedText ?? "").trim().toLowerCase();
    if (!needle || needle.length < 3) return null;
    const thread = this.getThread(channelId, 60);
    for (let i = thread.length - 1; i >= 0; i -= 1) {
      const row = thread[i];
      if (!row?.isFromBot) continue;
      if (String(row.text ?? "").trim().toLowerCase() === needle) return row;
      if (String(row.text ?? "").toLowerCase().includes(needle)) return row;
    }
    return null;
  }

  buildReplyContext(channelId, quotedMessageId, limit = 45) {
    const thread = this.getThread(channelId, limit);
    const quoted = quotedMessageId ? this.get(channelId, quotedMessageId) : null;
    const lines = thread.map((row) => {
      const who = row.isFromBot ? "Teto" : row.speakerName || row.actorId || "alguém";
      const mark = row.messageId === quotedMessageId ? " ← [MARCADA NO REPLY]" : "";
      return `${who}: ${row.text}${mark}`;
    });
    return {
      quoted,
      thread,
      formatted: lines.join("\n")
    };
  }
}
