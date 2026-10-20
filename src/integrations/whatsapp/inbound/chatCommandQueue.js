export class ChatCommandQueue {
  constructor() {
    this.queueByChat = new Map();
  }

  enqueue(chatId, task) {
    const key = String(chatId ?? "unknown");
    const current = this.queueByChat.get(key) ?? Promise.resolve();
    const next = current
      .catch(() => {})
      .then(() => task());
    this.queueByChat.set(key, next.finally(() => {
      if (this.queueByChat.get(key) === next) {
        this.queueByChat.delete(key);
      }
    }));
    return next;
  }
}
