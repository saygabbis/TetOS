import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

function bucketFor(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = (now - d) / (24 * 60 * 60 * 1000);
  if (diffDays < 1) return "hoje";
  if (diffDays < 7) return "semana";
  if (diffDays < 30) return "mes";
  if (diffDays < 365) return "ano";
  return "antigo";
}

function decayWeight(entry, now = Date.now()) {
  const ageDays = (now - Date.parse(entry.ts ?? 0)) / (24 * 60 * 60 * 1000);
  const salience = entry.salience ?? 0.5;
  return salience * Math.exp(-ageDays / 45);
}

export class EpisodicMemoryStore {
  constructor(path, { maxLoad = 2000 } = {}) {
    this.path = path;
    this.maxLoad = maxLoad;
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
    }).filter(Boolean).slice(-this.maxLoad);
  }

  save(entry) {
    const normalized = {
      id: entry.id ?? `ep_${Date.now()}`,
      userId: String(entry.userId ?? "default"),
      channelScope: entry.channelScope ?? "direct",
      sessionId: entry.sessionId ?? null,
      summary: String(entry.summary ?? entry.content ?? "").slice(0, 400),
      tags: entry.tags ?? [],
      salience: entry.salience ?? 0.5,
      emotionalTone: entry.emotionalTone ?? "neutral",
      ts: entry.ts ?? new Date().toISOString()
    };
    appendFileSync(this.path, `${JSON.stringify(normalized)}\n`);
    this.cache.push(normalized);
    return normalized;
  }

  retrieve({ userId, channelScope, query = null, limit = 12, now = Date.now() } = {}) {
    let items = this.cache.filter((e) => {
      const userMatch = !userId || e.userId === userId;
      const scopeMatch = !channelScope || e.channelScope === channelScope;
      return userMatch && scopeMatch;
    });

    if (query) {
      const q = String(query).toLowerCase();
      items = items.filter((e) => e.summary.toLowerCase().includes(q) || e.tags.some((t) => q.includes(t)));
    }

    return items
      .map((e) => ({ ...e, weight: decayWeight(e, now), bucket: bucketFor(e.ts) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  byBuckets({ userId, channelScope } = {}) {
    const items = this.retrieve({ userId, channelScope, limit: 100 });
    const buckets = { hoje: [], semana: [], mes: [], ano: [], antigo: [] };
    for (const item of items) {
      buckets[item.bucket]?.push(item);
    }
    return buckets;
  }

  tick() {
    return { count: this.cache.length };
  }
}
