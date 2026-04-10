import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = {
  firstInteractionAt: {},
  lastMessageAt: {},
  lastSeen: {}
};

export class TimeStore {
  constructor(path) {
    this.path = path;
    this.state = readJson(path, DEFAULT_STATE) ?? DEFAULT_STATE;
    this.state.firstInteractionAt ??= {};
    this.state.lastMessageAt ??= {};
    this.state.lastSeen ??= {};
  }

  save() {
    writeJson(this.path, this.state);
  }

  ensureFirstInteraction(userId, now) {
    const key = String(userId ?? "default");
    if (!this.state.firstInteractionAt[key]) {
      this.state.firstInteractionAt[key] = new Date(now).toISOString();
      this.save();
    }
  }

  markMessage(userId, now = Date.now()) {
    const key = String(userId ?? "default");
    this.ensureFirstInteraction(key, now);
    this.state.lastMessageAt[key] = new Date(now).toISOString();
    this.state.lastSeen[key] = new Date(now).toISOString();
    this.save();
  }

  markSeen(userId, now = Date.now()) {
    const key = String(userId ?? "default");
    this.ensureFirstInteraction(key, now);
    this.state.lastSeen[key] = new Date(now).toISOString();
    this.save();
  }

  getLastSeen(userId) {
    const key = String(userId ?? "default");
    return this.state.lastSeen[key] ?? null;
  }

  getLastMessage(userId) {
    const key = String(userId ?? "default");
    return this.state.lastMessageAt[key] ?? null;
  }
}
