import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value, fallback = "default") {
  const text = String(value ?? fallback).trim();
  return text || fallback;
}

function tokenize(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);
}

function overlapScore(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (!setA.size || !setB.size) return 0;
  let hits = 0;
  for (const token of setA) {
    if (setB.has(token)) hits += 1;
  }
  return hits / Math.max(setA.size, setB.size);
}

export class SelectiveMemoryStore {
  constructor(path, {
    capacity = 12,
    expirationMs = 6 * 60 * 60 * 1000,
    reinforcementThreshold = 3,
    candidateMaxLength = 240
  } = {}) {
    this.path = path;
    this.capacity = capacity;
    this.expirationMs = expirationMs;
    this.reinforcementThreshold = reinforcementThreshold;
    this.candidateMaxLength = candidateMaxLength;
    this.data = readJson(this.path, { items: [] });
    this.data.items ??= [];
  }

  all() {
    return [...this.data.items];
  }

  byScope({ userId = "default", channelId = "direct:default" } = {}) {
    const safeUserId = normalizeKey(userId);
    const safeChannelId = normalizeKey(channelId, `direct:${safeUserId}`);
    return this.data.items.filter(
      (item) => item.userId === safeUserId && item.channelId === safeChannelId
    );
  }

  cleanupExpired(now = Date.now()) {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((item) => Number(item.expiresAt ?? 0) > now);
    if (this.data.items.length !== before) {
      writeJson(this.path, this.data);
    }
  }

  buildCandidate(message, facts = []) {
    const text = normalizeText(message);
    if (!text) return [];

    const candidates = [];
    const compact = text.replace(/\s+/g, " ").trim();
    if (compact.length >= 18) {
      candidates.push(compact.slice(0, this.candidateMaxLength));
    }

    for (const fact of facts) {
      const type = normalizeText(fact?.type);
      const value = normalizeText(fact?.value);
      if (!type || !value) continue;
      candidates.push(`${type.replace(/^user_/, "")} = ${value}`.slice(0, this.candidateMaxLength));
    }

    return [...new Set(candidates)].slice(0, 4);
  }

  remember({ userId = "default", channelId = "direct:default", content, source = "message" }) {
    const safeUserId = normalizeKey(userId);
    const safeChannelId = normalizeKey(channelId, `direct:${safeUserId}`);
    const normalizedContent = normalizeText(content);
    if (!normalizedContent) return null;

    this.cleanupExpired();

    const scoped = this.byScope({ userId: safeUserId, channelId: safeChannelId });
    const existing = scoped.find((item) => {
      const direct = item.content.toLowerCase() === normalizedContent.toLowerCase();
      const inclusion =
        item.content.toLowerCase().includes(normalizedContent.toLowerCase()) ||
        normalizedContent.toLowerCase().includes(item.content.toLowerCase());
      const overlap = overlapScore(item.content, normalizedContent) >= 0.55;
      return direct || inclusion || overlap;
    });

    if (existing) {
      existing.reinforcementCount = Number(existing.reinforcementCount ?? 0) + 1;
      existing.lastSeenAt = Date.now();
      existing.expiresAt = Date.now() + this.expirationMs;
      existing.source = source;
      writeJson(this.path, this.data);
      return { ...existing, promoted: existing.reinforcementCount >= this.reinforcementThreshold };
    }

    const item = {
      id: crypto.randomUUID(),
      userId: safeUserId,
      channelId: safeChannelId,
      content: normalizedContent,
      source,
      reinforcementCount: 1,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      expiresAt: Date.now() + this.expirationMs
    };

    const scopedSorted = scoped.sort((a, b) => Number(a.lastSeenAt ?? 0) - Number(b.lastSeenAt ?? 0));
    const overflow = Math.max(0, scoped.length - this.capacity + 1);
    if (overflow > 0) {
      const removeIds = new Set(scopedSorted.slice(0, overflow).map((entry) => entry.id));
      this.data.items = this.data.items.filter((entry) => !removeIds.has(entry.id));
    }

    this.data.items.push(item);
    writeJson(this.path, this.data);
    return { ...item, promoted: false };
  }

  pullPromotions({ userId = "default", channelId = "direct:default" } = {}) {
    const safeUserId = normalizeKey(userId);
    const safeChannelId = normalizeKey(channelId, `direct:${safeUserId}`);
    const promoted = this.data.items.filter(
      (item) =>
        item.userId === safeUserId &&
        item.channelId === safeChannelId &&
        Number(item.reinforcementCount ?? 0) >= this.reinforcementThreshold
    );
    if (!promoted.length) return [];

    const promotedIds = new Set(promoted.map((item) => item.id));
    this.data.items = this.data.items.filter((item) => !promotedIds.has(item.id));
    writeJson(this.path, this.data);
    return promoted;
  }
}
