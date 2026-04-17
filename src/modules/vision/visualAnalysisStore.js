import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class VisualAnalysisStore {
  constructor(path = "./data/visualAnalyses.json") {
    this.path = path;
    this.data = readJson(this.path, { entries: [] });
    this.data.entries ??= [];
  }

  save({ userId, channelId, mediaPath, mediaType, description, source = "local_vision" } = {}) {
    const entry = {
      id: crypto.randomUUID(),
      userId: String(userId ?? "default"),
      channelId: String(channelId ?? "default"),
      mediaPath: mediaPath ?? null,
      mediaType: mediaType ?? null,
      description: String(description ?? "").trim(),
      source,
      createdAt: new Date().toISOString()
    };
    this.data.entries.push(entry);
    writeJson(this.path, this.data);
    return entry;
  }

  latestByUser(userId, limit = 5) {
    return this.data.entries
      .filter((item) => item.userId === String(userId ?? "default"))
      .slice(-limit);
  }
}
