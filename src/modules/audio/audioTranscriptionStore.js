import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class AudioTranscriptionStore {
  constructor(path = "./data/audioTranscriptions.json") {
    this.path = path;
    this.data = readJson(this.path, { entries: [] });
    this.data.entries ??= [];
  }

  save({ userId, channelId, mediaPath, transcript, source = "heuristic" } = {}) {
    const entry = {
      id: crypto.randomUUID(),
      userId: String(userId ?? "default"),
      channelId: String(channelId ?? "default"),
      mediaPath: mediaPath ?? null,
      transcript: String(transcript ?? "").trim(),
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
