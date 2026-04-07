export class ShortTermMemory {
  constructor(limit = 8) {
    this.limit = limit;
    this.sessions = new Map();
  }

  add(message, sessionId = "default") {
    const history = this.sessions.get(sessionId) ?? [];
    history.push(message);
    if (history.length > this.limit) {
      history.shift();
    }
    this.sessions.set(sessionId, history);
  }

  getAll(sessionId = "default") {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  clear(sessionId = "default") {
    this.sessions.delete(sessionId);
  }
}
