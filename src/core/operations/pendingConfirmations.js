import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class PendingConfirmationStore {
  constructor(path = "./data/pendingConfirmations.json") {
    this.path = path;
    this.data = readJson(this.path, { entries: [] });
    this.data.entries ??= [];
  }

  create({ userId, type, payload, ttlMs = 10 * 60 * 1000 } = {}) {
    const entry = {
      id: crypto.randomUUID(),
      userId: String(userId ?? "default"),
      type,
      payload,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs
    };
    this.cleanup();
    this.data.entries.push(entry);
    writeJson(this.path, this.data);
    return entry;
  }

  findLatest(userId) {
    this.cleanup();
    const safeUserId = String(userId ?? "default");
    const matches = this.data.entries.filter((entry) => entry.userId === safeUserId);
    return matches.at(-1) ?? null;
  }

  resolve(userId) {
    const entry = this.findLatest(userId);
    if (!entry) return null;
    this.data.entries = this.data.entries.filter((item) => item.id !== entry.id);
    writeJson(this.path, this.data);
    return entry;
  }

  cleanup() {
    const now = Date.now();
    this.data.entries = this.data.entries.filter((entry) => Number(entry.expiresAt ?? 0) > now);
    writeJson(this.path, this.data);
  }
}
