function scopeKey(chatId, userId) {
  const chat = String(chatId ?? "unknown");
  const user = String(userId ?? "").trim();
  return user ? `${chat}::${user}` : chat;
}

export class ChatMediaHistoryStore {
  constructor(limit = 30) {
    this.limit = Math.max(5, Number(limit) || 30);
    this.itemsByScope = new Map();
  }

  add(chatId, item, userId = null) {
    const key = scopeKey(chatId, userId ?? item?.userId);
    const list = this.itemsByScope.get(key) ?? [];
    list.push({
      ...item,
      userId: userId ?? item?.userId ?? null,
      ts: item?.ts ?? new Date().toISOString()
    });
    if (list.length > this.limit) {
      list.splice(0, list.length - this.limit);
    }
    this.itemsByScope.set(key, list);
  }

  latest(chatId, userId = null) {
    const key = scopeKey(chatId, userId);
    const list = this.itemsByScope.get(key) ?? [];
    return list.length ? list[list.length - 1] : null;
  }

  /** Busca mídia indexada pelo message id (varre escopos do chat). */
  findByMessageId(chatId, messageId) {
    const chat = String(chatId ?? "");
    const mid = String(messageId ?? "").trim();
    if (!chat || !mid) return null;
    let best = null;
    for (const [scope, list] of this.itemsByScope.entries()) {
      if (scope !== chat && !scope.startsWith(`${chat}::`)) continue;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (String(list[i]?.messageId ?? "") === mid) {
          best = list[i];
        }
      }
    }
    return best;
  }
}
