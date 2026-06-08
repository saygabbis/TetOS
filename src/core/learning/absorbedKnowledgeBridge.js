import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_PATTERNS = {
  rhythm: { peakHours: [], quietHours: [], avgResponseMs: 0, p50: 0, p90: 0 },
  initiation: { typicalGapHours: [], afterSilenceChance: 0 },
  style: { shortMsgRate: 0, laughterRate: 0, editRate: 0, deleteRate: 0 },
  topics: [],
  mediaHabits: { stickerRate: 0, imageRate: 0, reactionEmoji: {} },
  creativeInsights: [],
  lastUpdated: null
};

export class AbsorbedKnowledgeBridge {
  constructor(path, { ledger = null, bus = null } = {}) {
    this.path = path;
    this.ledger = ledger;
    this.bus = bus;
    this.patterns = readJson(path, DEFAULT_PATTERNS) ?? structuredClone(DEFAULT_PATTERNS);
  }

  save() {
    writeJson(this.path, this.patterns);
  }

  getPatterns() {
    return { ...this.patterns };
  }

  ingestEvent(event = {}) {
    const type = event.eventType ?? "unknown";
    const hour = new Date(event.ts ?? Date.now()).getHours();

    if (type === "message_incoming" || type === "message_outgoing") {
      this.bumpHour(this.patterns.rhythm.peakHours, hour);
      if (event.latencyMs) {
        this.patterns.rhythm.avgResponseMs = movingAvg(
          this.patterns.rhythm.avgResponseMs,
          event.latencyMs,
          0.05
        );
      }
      if (event.length && event.length < 40) {
        this.patterns.style.shortMsgRate = movingAvg(this.patterns.style.shortMsgRate, 1, 0.02);
      } else {
        this.patterns.style.shortMsgRate = movingAvg(this.patterns.style.shortMsgRate, 0, 0.02);
      }
    }

    if (event.hasLaughter) {
      this.patterns.style.laughterRate = movingAvg(this.patterns.style.laughterRate, 1, 0.03);
    }
    if (event.mediaType) {
      const key = `${event.mediaType}Rate`;
      if (this.patterns.mediaHabits[key] !== undefined) {
        this.patterns.mediaHabits[key] = movingAvg(this.patterns.mediaHabits[key], 1, 0.02);
      }
    }
    if (event.topic) {
      this.bumpTopic(event.topic);
    }

    this.patterns.lastUpdated = new Date().toISOString();
    this.save();
    return this.patterns;
  }

  bumpHour(list, hour) {
    const entry = list.find((h) => h.hour === hour);
    if (entry) entry.weight += 1;
    else list.push({ hour, weight: 1 });
    list.sort((a, b) => b.weight - a.weight);
    if (list.length > 24) list.length = 24;
    this.patterns.rhythm.peakHours = list.slice(0, 5).map((h) => h.hour);
    this.patterns.rhythm.quietHours = list.slice(-3).map((h) => h.hour);
  }

  bumpTopic(label) {
    const key = String(label).slice(0, 60);
    const existing = this.patterns.topics.find((t) => t.label === key);
    if (existing) existing.weight += 0.05;
    else this.patterns.topics.push({ label: key, weight: 0.1 });
    this.patterns.topics.sort((a, b) => b.weight - a.weight);
    if (this.patterns.topics.length > 30) this.patterns.topics.length = 30;
  }

  addInsight(insight) {
    this.patterns.creativeInsights.push({
      ...insight,
      ts: new Date().toISOString()
    });
    if (this.patterns.creativeInsights.length > 50) {
      this.patterns.creativeInsights = this.patterns.creativeInsights.slice(-50);
    }
    this.save();
    this.bus?.emit("knowledge.insight_added", insight);
  }

  tick() {
    return this.getPatterns();
  }
}

function movingAvg(current, sample, alpha) {
  const c = Number(current) || 0;
  return c + alpha * (sample - c);
}
