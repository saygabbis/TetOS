import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { resolveTimeLookupKeys, resolveTimeWriteKey } from "./timeKeys.js";

const DEFAULT_STATE = {
  firstInteractionAt: {},
  lastMessageAt: {},
  lastUserMessageAt: {},
  lastAssistantMessageAt: {},
  lastSeen: {}
};

export class TimeStore {
  constructor(path) {
    this.path = path;
    this.state = readJson(path, DEFAULT_STATE) ?? DEFAULT_STATE;
    this.state.firstInteractionAt ??= {};
    this.state.lastMessageAt ??= {};
    this.state.lastUserMessageAt ??= {};
    this.state.lastAssistantMessageAt ??= {};
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

  markMessage(userId, now = Date.now(), sessionId = null) {
    this.markUserMessage(userId, now, sessionId);
  }

  markUserMessage(userId, now = Date.now(), sessionId = null) {
    const writeKey = resolveTimeWriteKey(userId, sessionId);
    this.ensureFirstInteraction(writeKey, now);
    const iso = new Date(now).toISOString();
    this.state.lastUserMessageAt[writeKey] = iso;
    this.state.lastMessageAt[writeKey] = iso;
    this.state.lastSeen[writeKey] = iso;
    this.save();
  }

  markAssistantMessage(userId, now = Date.now(), sessionId = null) {
    const writeKey = resolveTimeWriteKey(userId, sessionId);
    this.ensureFirstInteraction(writeKey, now);
    const iso = new Date(now).toISOString();
    this.state.lastAssistantMessageAt[writeKey] = iso;
    this.state.lastMessageAt[writeKey] = iso;
    this.save();
  }

  markSeen(userId, now = Date.now(), sessionId = null) {
    const writeKey = resolveTimeWriteKey(userId, sessionId);
    this.ensureFirstInteraction(writeKey, now);
    this.state.lastSeen[writeKey] = new Date(now).toISOString();
    this.save();
  }

  getLastSeen(userId, sessionId = null) {
    for (const key of resolveTimeLookupKeys(userId, sessionId)) {
      const seen = this.state.lastSeen[key];
      if (seen) return seen;
    }
    return null;
  }

  getLastMessage(userId, sessionId = null) {
    let best = null;
    let bestTs = 0;
    for (const key of resolveTimeLookupKeys(userId, sessionId)) {
      const at = this.state.lastMessageAt[key];
      if (!at) continue;
      const ts = Date.parse(at);
      if (Number.isFinite(ts) && ts >= bestTs) {
        bestTs = ts;
        best = at;
      }
    }
    return best;
  }

  getLastUserMessage(userId, sessionId = null) {
    let best = null;
    let bestTs = 0;
    for (const key of resolveTimeLookupKeys(userId, sessionId)) {
      const at =
        this.state.lastUserMessageAt[key] ?? this.state.lastMessageAt[key];
      if (!at) continue;
      const ts = Date.parse(at);
      if (Number.isFinite(ts) && ts >= bestTs) {
        bestTs = ts;
        best = at;
      }
    }
    return best;
  }

  gapSinceUserMs(userId, sessionId = null, now = Date.now()) {
    const last = this.getLastUserMessage(userId, sessionId);
    if (!last) return 0;
    const ts = Date.parse(last);
    return Number.isFinite(ts) ? Math.max(0, now - ts) : 0;
  }
}
