import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class LongTermMemory {
  constructor(path) {
    this.path = path;
    this.data = readJson(this.path, { entries: [], profiles: {}, mediumTerm: {} });
    this.data.profiles ??= {};
    this.data.mediumTerm ??= {};
  }

  save(entry) {
    const payload = {
      id: crypto.randomUUID(),
      ...entry,
      timestamp: new Date().toISOString()
    };

    this.data.entries.push(payload);
    writeJson(this.path, this.data);
    return payload;
  }

  all() {
    return this.data.entries;
  }

  search({ tag, query }) {
    const normalizedTags = tag
      ? String(tag)
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : [];
    const normalizedQuery = query ? String(query).toLowerCase() : null;

    return this.data.entries.filter((entry) => {
      const tags = Array.isArray(entry.tags)
        ? entry.tags.map((item) => String(item).toLowerCase())
        : [String(entry.tag ?? "").toLowerCase()].filter(Boolean);
      const entryContent = String(entry.content ?? "").toLowerCase();

      const tagMatch = normalizedTags.length
        ? normalizedTags.some((wanted) => tags.includes(wanted))
        : true;
      const queryMatch = normalizedQuery
        ? entryContent.includes(normalizedQuery)
        : true;

      return tagMatch && queryMatch;
    });
  }

  delete(id) {
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((entry) => entry.id !== id);
    const removed = before - this.data.entries.length;
    if (removed > 0) {
      writeJson(this.path, this.data);
    }
    return removed;
  }

  getProfile(userId = "default") {
    return this.data.profiles[userId] ?? { facts: {}, style: {}, counts: {} };
  }

  updateProfile(userId = "default", patch = {}) {
    const current = this.getProfile(userId);
    const next = {
      ...current,
      ...patch,
      facts: { ...current.facts, ...(patch.facts ?? {}) },
      style: { ...current.style, ...(patch.style ?? {}) },
      counts: { ...current.counts, ...(patch.counts ?? {}) },
      lastUpdated: new Date().toISOString()
    };
    this.data.profiles[userId] = next;
    writeJson(this.path, this.data);
    return next;
  }

  getMediumTerm(userId = "default") {
    return this.data.mediumTerm[userId] ?? [];
  }

  addMediumTerm(userId = "default", entry, limit = 20) {
    const list = this.getMediumTerm(userId);
    const next = [...list, entry].slice(-limit);
    this.data.mediumTerm[userId] = next;
    writeJson(this.path, this.data);
    return next;
  }

  pruneMediumTerm(userId = "default", limit = 20) {
    const list = this.getMediumTerm(userId);
    if (list.length <= limit) return list;
    const next = list.slice(-limit);
    this.data.mediumTerm[userId] = next;
    writeJson(this.path, this.data);
    return next;
  }
}
