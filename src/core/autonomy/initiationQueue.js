import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = { entries: [] };

export class InitiationQueue {
  constructor(path = "./data/initiationQueue.json") {
    this.path = path;
    this.data = readJson(path, DEFAULT_STATE) ?? structuredClone(DEFAULT_STATE);
    this.data.entries ??= [];
  }

  save() {
    writeJson(this.path, this.data);
  }

  cancelForUser(userId = "default") {
    const uid = String(userId ?? "").trim();
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => e.userId !== uid || e.status === "sent");
    if (this.data.entries.length !== before) this.save();
  }

  schedule({
    userId = "default",
    sessionId = null,
    mode = "spontaneous",
    impulse = "",
    deferMs = 300000,
    brainSeed = null,
    meta = {}
  } = {}) {
    const uid = String(userId ?? "").trim();
    if (!uid) return null;

    this.cancelForUser(uid);

    const now = Date.now();
    const entry = {
      id: `init_${now}_${Math.random().toString(36).slice(2, 8)}`,
      userId: uid,
      sessionId: sessionId ?? `wa-${uid}`,
      mode,
      impulse: String(impulse ?? "").slice(0, 500),
      brainSeed,
      scheduledFor: new Date(now + Math.max(2_400_000, deferMs)).toISOString(),
      createdAt: new Date(now).toISOString(),
      status: "pending",
      meta
    };

    this.data.entries.push(entry);
    if (this.data.entries.length > 200) {
      this.data.entries = this.data.entries.filter((e) => e.status !== "sent").slice(-120);
    }
    this.save();
    return entry;
  }

  dueEntries(now = Date.now()) {
    return this.data.entries.filter(
      (e) => e.status === "pending" && Date.parse(e.scheduledFor) <= now
    );
  }

  markSent(id) {
    const entry = this.data.entries.find((e) => e.id === id);
    if (entry) {
      entry.status = "sent";
      entry.sentAt = new Date().toISOString();
      this.save();
    }
    return entry;
  }

  pendingForUser(userId) {
    return this.data.entries.find((e) => e.userId === userId && e.status === "pending") ?? null;
  }
}
