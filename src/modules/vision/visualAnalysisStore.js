import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class VisualAnalysisStore {
  constructor(path = "./data/visualAnalyses.json", { maxPerScope = 10, maxDescriptionLength = 400 } = {}) {
    this.path = path;
    this.maxPerScope = Math.max(3, Number(maxPerScope) || 10);
    this.maxDescriptionLength = Math.max(120, Number(maxDescriptionLength) || 400);
    this.data = readJson(this.path, { entries: [] });
    this.data.entries ??= [];
  }

  save({ userId, channelId, mediaPath, mediaType, description, source = "local_vision" } = {}) {
    const safeUserId = String(userId ?? "default");
    const safeChannelId = String(channelId ?? "default");
    const entry = {
      id: crypto.randomUUID(),
      userId: safeUserId,
      channelId: safeChannelId,
      mediaPath: mediaPath ?? null,
      mediaType: mediaType ?? null,
      description: String(description ?? "").trim().slice(0, this.maxDescriptionLength),
      source,
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

  latestByUser(userId, limit = 5, channelId = null) {
    return this.latestByScope(userId, channelId, limit);
  }

  latestByScope(userId, channelId = null, limit = 5) {
    let rows = this.data.entries.filter((item) => item.userId === String(userId ?? "default"));
    if (channelId) {
      rows = rows.filter((item) => item.channelId === String(channelId));
    }
    return rows.slice(-Math.max(1, Number(limit) || 5));
  }
}
