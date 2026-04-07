export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(name, handler) {
    this.tools.set(name, handler);
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.keys()];
  }
}
