import { EventEmitter } from "node:events";

/** Barramento interno de eventos da UI desktop (protocolo neutro). */
export class UiEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.lastEventId = 0;
  }

  publish(event) {
    this.lastEventId += 1;
    const envelope = { id: this.lastEventId, event };
    this.emit("event", envelope);
    return envelope;
  }
}
