import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { contextualSeed, chance } from "./rng.js";

const DEFAULT_STATE = {
  sessions: {}
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(text) {
  const n = normalizeText(text);
  if (!n || n.length < 8) return null;
  return n.slice(0, 120);
}

export class RepetitionAwareness {
  constructor(path, { maxPerSession = 80, windowDays = 7 } = {}) {
    this.path = path;
    this.maxPerSession = maxPerSession;
    this.windowDays = windowDays;
    this.data = readJson(path, DEFAULT_STATE) ?? DEFAULT_STATE;
    this.data.sessions ??= {};
  }

  save() {
    writeJson(this.path, this.data);
  }

  getSession(sessionId = "default") {
    const key = String(sessionId ?? "default");
    if (!this.data.sessions[key]) {
      this.data.sessions[key] = { utterances: [], topics: {}, lastUpdated: null };
    }
    return this.data.sessions[key];
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowDays * 24 * 60 * 60 * 1000;
    for (const [key, session] of Object.entries(this.data.sessions)) {
      session.utterances = (session.utterances ?? []).filter(
        (item) => Date.parse(item.ts ?? 0) >= cutoff
      );
      if (!session.utterances.length && !session.lastUpdated) {
        delete this.data.sessions[key];
      }
    }
    this.save();
  }

  record(sessionId, text, meta = {}) {
    const fp = fingerprint(text);
    if (!fp) return null;
    const session = this.getSession(sessionId);
    const now = new Date().toISOString();
    const entry = {
      fp,
      text: String(text ?? "").slice(0, 240),
      role: meta.role ?? "assistant",
      topic: meta.topic ?? null,
      ts: now
    };
    session.utterances.push(entry);
    if (session.utterances.length > this.maxPerSession) {
      session.utterances = session.utterances.slice(-this.maxPerSession);
    }
    if (meta.topic) {
      session.topics[meta.topic] = (session.topics[meta.topic] ?? 0) + 1;
    }
    session.lastUpdated = now;
    this.save();
    return entry;
  }

  scoreRepetition(sessionId, candidateText) {
    const fp = fingerprint(candidateText);
    if (!fp) return { score: 0, repeated: false, matches: [] };
    const session = this.getSession(sessionId);
    const matches = (session.utterances ?? []).filter(
      (item) => item.fp === fp || overlapRatio(item.fp, fp) > 0.85
    );
    const recent = matches.filter(
      (item) => Date.now() - Date.parse(item.ts) < 7 * 24 * 60 * 60 * 1000
    );
    const score = clamp01(recent.length * 0.25 + matches.length * 0.1);
    return {
      score,
      repeated: recent.length > 0,
      matches: recent.slice(-3),
      totalMatches: matches.length
    };
  }

  getSnapshot(sessionId = "default") {
    return this.influence(sessionId);
  }

  influence(sessionId, context = {}) {
    const session = this.getSession(sessionId);
    const recent = (session.utterances ?? []).slice(-12);
    const topicCounts = session.topics ?? {};
    const overusedTopics = Object.entries(topicCounts)
      .filter(([, count]) => count >= 3)
      .map(([topic]) => topic);
    const seed = contextualSeed([sessionId, recent.length, overusedTopics.join(",")]);
    const shouldVary = chance(seed, 0.35 + overusedTopics.length * 0.08);
    const shouldStayQuiet = chance(seed + 1, clamp01(recent.length * 0.02));

    return {
      shouldVary,
      shouldStayQuiet,
      overusedTopics,
      recentCount: recent.length,
      suggestion: shouldVary
        ? "vary_phrasing"
        : shouldStayQuiet
          ? "consider_silence"
          : "normal",
      avoidPhrases: recent.filter((u) => u.role === "assistant").slice(-5).map((u) => u.fp)
    };
  }

  tick(now = Date.now()) {
    this.prune(now);
    return { sessions: Object.keys(this.data.sessions).length };
  }
}

function overlapRatio(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.split(" "));
  const setB = new Set(b.split(" "));
  let hits = 0;
  for (const token of setA) {
    if (setB.has(token)) hits += 1;
  }
  return hits / Math.max(setA.size, setB.size, 1);
}
