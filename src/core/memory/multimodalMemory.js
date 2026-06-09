import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class MultimodalMemoryStore {
  constructor(path = "./data/multimodalMemory.json", { maxPerScope = 12, maxTextLength = 320 } = {}) {
    this.path = path;
    this.maxPerScope = Math.max(4, Number(maxPerScope) || 12);
    this.maxTextLength = Math.max(80, Number(maxTextLength) || 320);
    this.data = readJson(this.path, { entries: [] });
    this.data.entries ??= [];
  }

  save({ userId, channelId, media, message } = {}) {
    if (!media?.type && !message) return null;
    const safeUserId = String(userId ?? "default");
    const safeChannelId = String(channelId ?? "default");
    const entry = {
      id: crypto.randomUUID(),
      userId: safeUserId,
      channelId: safeChannelId,
      mediaType: media?.type ?? null,
      mediaPath: media?.path ?? null,
      text: String(message ?? "").trim().slice(0, this.maxTextLength),
      createdAt: new Date().toISOString()
    };
    this.data.entries.push(entry);
    this.pruneScope(safeUserId, safeChannelId);
    writeJson(this.path, this.data);
    return entry;
  }

  pruneScope(userId, channelId) {
    const scoped = this.data.entries.filter(
      (item) => item.userId === String(userId) && item.channelId === String(channelId)
    );
    if (scoped.length <= this.maxPerScope) return;
    const drop = scoped.length - this.maxPerScope;
    let removed = 0;
    this.data.entries = this.data.entries.filter((item) => {
      if (removed >= drop) return true;
      if (item.userId === String(userId) && item.channelId === String(channelId)) {
        removed += 1;
        return false;
      }
      return true;
    });
  }

  list(userId = null, channelId = null, limit = 3) {
    let rows = [...this.data.entries];
    if (userId) rows = rows.filter((item) => item.userId === String(userId));
    if (channelId) rows = rows.filter((item) => item.channelId === String(channelId));
    const cap = Math.max(1, Number(limit) || 3);
    return rows.slice(-cap);
  }
}
