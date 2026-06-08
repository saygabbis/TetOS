import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

function fixEncoding(text) {
  const s = String(text ?? "");
  if (!/Ã|Â|â€™|Ã©|Ã£/.test(s)) return s;
  try {
    return Buffer.from(s, "latin1").toString("utf8");
  } catch {
    return s;
  }
}

function profileKey(userId = "default", channelScope = "direct") {
  const uid = String(userId ?? "default");
  return channelScope && channelScope !== "direct" ? `${uid}::${channelScope}` : uid;
}

function dedupeKey(entry) {
  return `${entry.userId ?? "default"}|${String(entry.content ?? entry.value ?? "").toLowerCase().trim()}`;
}

export class LongTermMemory {
  constructor(path) {
    this.path = path;
    this.data = readJson(this.path, { entries: [], profiles: {}, mediumTerm: {} });
    this.data.profiles ??= {};
    this.data.mediumTerm ??= {};
  }

  save(entry) {
    const normalizedUserId = String(entry?.userId ?? "default");
    const normalizedContent = fixEncoding(String(entry?.content ?? entry?.value ?? "").trim());
    const channelScope = entry?.channelScope ?? "direct";

    const duplicate = this.data.entries.find(
      (existing) => dedupeKey(existing) === dedupeKey({ userId: normalizedUserId, content: normalizedContent })
    );
    if (duplicate) {
      duplicate.timestamp = new Date().toISOString();
      if (entry?.tags) duplicate.tags = entry.tags;
      if (channelScope !== "direct") duplicate.channelScope = channelScope;
      writeJson(this.path, this.data);
      return duplicate;
    }

    const payload = {
      id: crypto.randomUUID(),
      ...entry,
      userId: normalizedUserId,
      content: normalizedContent,
      channelScope,
      timestamp: new Date().toISOString()
    };

    this.data.entries.push(payload);
    writeJson(this.path, this.data);
    return payload;
  }

  all() {
    return this.data.entries;
  }

  byUser(userId = "default", channelScope = null) {
    const normalizedUserId = String(userId ?? "default");
    return this.data.entries.filter((entry) => {
      const userMatch = String(entry?.userId ?? "default") === normalizedUserId;
      if (!userMatch) return false;
      if (!channelScope || channelScope === "direct") return true;
      return !entry.channelScope || entry.channelScope === channelScope || entry.channelScope === "direct";
    });
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

  getProfile(userId = "default", channelScope = "direct") {
    const key = profileKey(userId, channelScope);
    return this.data.profiles[key] ?? this.data.profiles[userId] ?? { facts: {}, style: {}, counts: {} };
  }

  updateProfile(userId = "default", patch = {}, channelScope = "direct") {
    const key = profileKey(userId, channelScope);
    const current = this.getProfile(userId, channelScope);
    const next = {
      ...current,
      ...patch,
      facts: { ...current.facts, ...(patch.facts ?? {}) },
      style: { ...current.style, ...(patch.style ?? {}) },
      counts: { ...current.counts, ...(patch.counts ?? {}) },
      channelScope,
      lastUpdated: new Date().toISOString()
    };
    this.data.profiles[key] = next;
    writeJson(this.path, this.data);
    return next;
  }

  getMediumTerm(userId = "default", channelScope = "direct") {
    const key = profileKey(userId, channelScope);
    return this.data.mediumTerm[key] ?? this.data.mediumTerm[userId] ?? [];
  }

  addMediumTerm(userId = "default", entry, limit = 20, channelScope = "direct") {
    const key = profileKey(userId, channelScope);
    const list = this.getMediumTerm(userId, channelScope);
    const next = [...list, entry].slice(-limit);
    this.data.mediumTerm[key] = next;
    writeJson(this.path, this.data);
    return next;
  }

  pruneMediumTerm(userId = "default", limit = 20, channelScope = "direct") {
    const key = profileKey(userId, channelScope);
    const list = this.getMediumTerm(userId, channelScope);
    if (list.length <= limit) return list;
    const next = list.slice(-limit);
    this.data.mediumTerm[key] = next;
    writeJson(this.path, this.data);
    return next;
  }

  dedupeAll() {
    const seen = new Set();
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((entry) => {
      const key = dedupeKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      entry.content = fixEncoding(entry.content ?? entry.value ?? "");
      return true;
    });
    if (this.data.entries.length !== before) {
      writeJson(this.path, this.data);
    }
    return { before, after: this.data.entries.length };
  }
}
