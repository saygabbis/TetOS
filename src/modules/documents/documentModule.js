export class DocumentModule {
  constructor({ store, writer = null, enabled = true } = {}) {
    this.store = store;
    this.writer = writer;
    this.enabled = enabled;
  }

  isEnabled() {
    return Boolean(this.enabled && this.store);
  }

  list() {
    return this.store.list();
  }

  read(id) {
    return this.store.read(id);
  }

  write(id, content) {
    return this.store.write(id, content);
  }

  async assistWrite(id, instruction) {
    if (!this.writer) {
      return { document: this.write(id, instruction), mode: "direct-fallback" };
    }
    return this.writer.assistWrite(id, instruction);
  }

  canHandle(text) {
    const t = String(text ?? "").toLowerCase();
    return /\b(documento|arquivo|anota[cç][aã]o|nota|nota local|documento local)\b/.test(t);
  }
}
