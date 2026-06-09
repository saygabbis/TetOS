import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { contextualSeed, chance } from "../brain/rng.js";

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4);
}

function decayStrength(entry, now = Date.now()) {
  const ageMs = now - Date.parse(entry.ts ?? 0);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays < 1) return 1;
  if (ageDays < 7) return 0.85;
  if (ageDays < 30) return 0.5;
  if (ageDays < 365) return 0.2;
  return 0.05;
}

export class GroupMemoryStore {
  constructor(path, { maxEntries = 500, bus = null } = {}) {
    this.path = path;
    this.maxEntries = maxEntries;
    this.bus = bus;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.cache = this.loadAll();
  }

  loadAll() {
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  append(entry) {
    const normalized = {
      id: entry.id ?? `gm_${Date.now()}`,
      channelId: String(entry.channelId ?? "group:unknown"),
      userId: entry.userId ?? null,
      speakerName: entry.speakerName ?? null,
      text: String(entry.text ?? "").slice(0, 500),
      ts: entry.ts ?? new Date().toISOString(),
      tags: entry.tags ?? [],
      salience: entry.salience ?? 0.5,
      addressedToTeto: entry.addressedToTeto ?? false
    };
    appendFileSync(this.path, `${JSON.stringify(normalized)}\n`);
    this.cache.push(normalized);
    if (this.cache.length > this.maxEntries) {
      this.cache = this.cache.slice(-this.maxEntries);
    }
    return normalized;
  }

  byChannel(channelId, { limit = 30, now = Date.now() } = {}) {
    return this.cache
      .filter((e) => e.channelId === channelId)
      .map((e) => ({ ...e, strength: decayStrength(e, now) * (e.salience ?? 0.5) }))
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
      .slice(0, limit);
  }

  recall(channelId, query, { now = Date.now() } = {}) {
    const tokens = new Set(tokenize(query));
    const matches = this.byChannel(channelId, { limit: 100, now })
      .map((entry) => {
        const entryTokens = tokenize(entry.text);
        let hits = 0;
        for (const t of entryTokens) {
          if (tokens.has(t)) hits += 1;
        }
        const score = hits / Math.max(tokens.size, 1) * entry.strength;
        return { entry, score };
      })
      .filter((m) => m.score > 0.15)
      .sort((a, b) => b.score - a.score);

    if (matches.length) {
      const seed = contextualSeed([channelId, query]);
      if (chance(seed, 0.5 + matches[0].score * 0.3)) {
        this.bus?.emit("memory.triggered_recall", {
          channelId,
          query,
          recalled: matches.slice(0, 3).map((m) => m.entry)
        });
      }
    }
    return matches.slice(0, 5).map((m) => m.entry);
  }

  summarize(channelId) {
    const recent = this.byChannel(channelId, { limit: 15 });
    const strong = recent.filter((e) => e.strength > 0.6);
    return {
      channelId,
      recentCount: recent.length,
      strongCount: strong.length,
      highlights: strong.slice(0, 5).map((e) => ({
        text: e.text.slice(0, 120),
        ts: e.ts,
        strength: e.strength
      }))
    };
  }

  tick() {
    return { entries: this.cache.length };
  }
}
