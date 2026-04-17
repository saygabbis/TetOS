import { readJson, writeJson } from "../utils/fileStore.js";

export class MetricsStore {
  constructor(path = "./data/metrics.json") {
    this.path = path;
    this.data = readJson(this.path, {
      counters: {},
      lastUpdated: null
    });
    this.data.counters ??= {};
  }

  increment(name, amount = 1) {
    this.data.counters[name] = (this.data.counters[name] ?? 0) + amount;
    this.data.lastUpdated = new Date().toISOString();
    writeJson(this.path, this.data);
    return this.data.counters[name];
  }

  getAll() {
    return {
      counters: { ...(this.data.counters ?? {}) },
      lastUpdated: this.data.lastUpdated ?? null
    };
  }
}
