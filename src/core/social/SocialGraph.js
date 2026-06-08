import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { contextualSeed, chance, pick } from "../brain/rng.js";

const DEFAULT_GRAPH = {
  npcs: {
    miku: {
      name: "Hatsune Miku",
      role: "best_friend",
      trust: 0.92,
      intimacy: 0.88,
      affinity: 0.9,
      lastContactAt: null,
      moodToward: "warm",
      history: []
    },
    rin: {
      name: "Kagamine Rin",
      role: "friend",
      trust: 0.65,
      intimacy: 0.5,
      affinity: 0.6,
      lastContactAt: null,
      moodToward: "neutral",
      history: []
    },
    producer_k: {
      name: "Produtor K",
      role: "collaborator",
      trust: 0.55,
      intimacy: 0.35,
      affinity: 0.5,
      lastContactAt: null,
      moodToward: "professional",
      history: []
    },
    hater_x: {
      name: "Hater anônimo",
      role: "rival",
      trust: 0.1,
      intimacy: 0.05,
      affinity: 0.15,
      lastContactAt: null,
      moodToward: "annoyed",
      history: []
    }
  },
  offscreenEvents: []
};

export class SocialGraph {
  constructor(path, { bus = null, journalAppend = null } = {}) {
    this.path = path;
    this.bus = bus;
    this.journalAppend = journalAppend;
    this.data = readJson(path, DEFAULT_GRAPH) ?? structuredClone(DEFAULT_GRAPH);
    this.data.npcs ??= { ...DEFAULT_GRAPH.npcs };
    this.data.offscreenEvents ??= [];
  }

  save() {
    writeJson(this.path, this.data);
  }

  getNpc(id) {
    return this.data.npcs[id] ?? null;
  }

  getAll() {
    return { ...this.data.npcs };
  }

  adjustRelation(npcId, { trust = 0, intimacy = 0, affinity = 0, moodToward = null } = {}) {
    const npc = this.data.npcs[npcId];
    if (!npc) return null;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    npc.trust = clamp01(npc.trust + trust);
    npc.intimacy = clamp01(npc.intimacy + intimacy);
    npc.affinity = clamp01(npc.affinity + affinity);
    if (moodToward) npc.moodToward = moodToward;
    npc.lastContactAt = new Date().toISOString();
    this.save();
    return npc;
  }

  recordOffscreenEvent(event) {
    const entry = {
      id: `off_${Date.now()}`,
      ts: new Date().toISOString(),
      ...event
    };
    this.data.offscreenEvents.push(entry);
    if (this.data.offscreenEvents.length > 200) {
      this.data.offscreenEvents = this.data.offscreenEvents.slice(-200);
    }
    if (event.npcId && this.data.npcs[event.npcId]) {
      const npc = this.data.npcs[event.npcId];
      npc.history.push({ type: event.type, ts: entry.ts, summary: event.summary });
      if (npc.history.length > 30) npc.history = npc.history.slice(-30);
      npc.lastContactAt = entry.ts;
    }
    this.save();
    this.journalAppend?.(entry);
    this.bus?.emit("social.offscreen_chat", entry);
    return entry;
  }

  getSnapshot() {
    return {
      npcs: this.getAll(),
      recentOffscreen: this.data.offscreenEvents.slice(-5)
    };
  }

  tickBackground(ctx) {
    return this.tick(ctx);
  }

  tick({ hourOfDay = new Date().getHours(), emotion = null, availability = "awake" } = {}) {
    if (availability !== "awake") return { events: [] };
    const seed = contextualSeed([hourOfDay, emotion?.mood, Object.keys(this.data.npcs).length]);
    const events = [];

    if (chance(seed, 0.08)) {
      const npcId = pick(seed + 1, ["miku", "rin", "producer_k"]);
      const templates = [
        { type: "chat", summary: "conversa rápida sobre música" },
        { type: "missed_call", summary: "perdeu ligação, vai responder depois" },
        { type: "collab_idea", summary: "surgiu ideia de collab" },
        { type: "reconcile", summary: "fizeram as pazes depois de mal-entendido" },
        { type: "jealousy_light", summary: "ciúmes leve por atenção" }
      ];
      const tpl = pick(seed + 2, templates);
      const event = this.recordOffscreenEvent({
        npcId,
        ...tpl,
        generated: true
      });
      if (tpl.type === "reconcile") {
        this.adjustRelation(npcId, { trust: 0.03, intimacy: 0.04, moodToward: "warm" });
      }
      if (tpl.type === "missed_call" && npcId === "miku") {
        this.adjustRelation("miku", { intimacy: -0.01 });
      }
      events.push(event);
    }

    return {
      events,
      miku: this.getNpc("miku"),
      recentOffscreen: this.data.offscreenEvents.slice(-5)
    };
  }
}
