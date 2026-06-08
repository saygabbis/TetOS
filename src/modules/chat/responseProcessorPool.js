import { ResponseProcessor } from "./responseProcessor.js";

/** Um ResponseProcessor por sessionId — evita vazamento de histórico entre chats. */
export class ResponseProcessorPool {
  constructor(options = {}) {
    this.options = options;
    this.processors = new Map();
  }

  forSession(sessionId = "default") {
    const key = String(sessionId || "default");
    if (!this.processors.has(key)) {
      this.processors.set(key, new ResponseProcessor(this.options));
    }
    return this.processors.get(key);
  }

  clear(sessionId) {
    if (sessionId) this.processors.delete(String(sessionId));
    else this.processors.clear();
  }
}
