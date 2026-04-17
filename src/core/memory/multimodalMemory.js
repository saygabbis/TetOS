import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class MultimodalMemoryStore {
  constructor(path = "./data/multimodalMemory.json") {
    this.path = path;
    this.data = readJson(this.path, { entries: [] });
    this.data.entries ??= [];
  }

  save({ userId, channelId, media, message } = {}) {
    if (!media?.type && !message) return null;
    const entry = {
      id: crypto.randomUUID(),
      userId: String(userId ?? "default"),
      channelId: String(channelId ?? "default"),
      mediaType: media?.type ?? null,
      mediaPath: media?.path ?? null,
      text: String(message ?? "").trim(),
      createdAt: new Date().toISOString()
    };
    this.data.entries.push(entry);
    writeJson(this.path, this.data);
    return entry;
  }

  list(userId = null) {
    const all = [...this.data.entries];
    if (!userId) return all;
    return all.filter((item) => item.userId === String(userId));
  }
}
