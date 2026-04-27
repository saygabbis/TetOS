export class ChatMediaHistoryStore {
  constructor(limit = 30) {
    this.limit = Math.max(5, Number(limit) || 30);
    this.itemsByChat = new Map();
  }

  add(chatId, item) {
    const key = String(chatId ?? "unknown");
    const list = this.itemsByChat.get(key) ?? [];
    list.push({
      ...item,
      ts: item?.ts ?? new Date().toISOString()
    });
    if (list.length > this.limit) {
      list.splice(0, list.length - this.limit);
    }
    this.itemsByChat.set(key, list);
  }

  latest(chatId) {
    const key = String(chatId ?? "unknown");
    const list = this.itemsByChat.get(key) ?? [];
    return list.length ? list[list.length - 1] : null;
  }
}
