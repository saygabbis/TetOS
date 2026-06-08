export class SignalBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  emit(event, payload = {}) {
    const list = this.listeners.get(event) ?? [];
    for (const handler of list) {
      try {
        handler(payload);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}
