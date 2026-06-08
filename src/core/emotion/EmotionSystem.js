import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { EmotionBlendRegistry } from "./EmotionBlendRegistry.js";
import { BodyNeeds } from "./BodyNeeds.js";
import { HealthConditions } from "./HealthConditions.js";

const DEFAULT_STATE = {
  mood: "neutral",
  energy: 0.7,
  social: 0.6,
  focus: 0.5,
  stress: 0.25,
  playfulness: 0.55,
  irritability: 0.2,
  vulnerability: 0.3,
  lastUpdated: null
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export class EmotionSystem {
  constructor(path, {
    blendPath = null,
    bodyPath = null,
    healthPath = null,
    bus = null
  } = {}) {
    this.path = path;
    this.bus = bus;
    this.state = readJson(path, DEFAULT_STATE) ?? { ...DEFAULT_STATE };
    this.blends = new EmotionBlendRegistry(blendPath ?? path.replace(/emotionState/, "emotionBlends"));
    this.body = bodyPath ? new BodyNeeds(bodyPath, { bus }) : null;
    this.health = healthPath ? new HealthConditions(healthPath, { bus }) : null;
  }

  save() {
    writeJson(this.path, this.state);
  }

  getSnapshot() {
    return {
      ...this.state,
      blends: this.blends.getBlends(),
      dominant: this.blends.dominant(),
      vector: this.blends.vector(),
      body: this.body?.getState() ?? null,
      health: this.health?.getActive() ?? []
    };
  }

  applyEvent(event = {}) {
    const { type, intensity = 0.05, emotion = null } = event;
    const map = {
      positive_interaction: { alegria: 0.06, carinho: 0.04 },
      negative_interaction: { irritação: 0.05, frustração: 0.04 },
      loneliness: { solidão: 0.06, melancolia: 0.03 },
      hype_moment: { hype: 0.08, antecipação: 0.05 },
      vulnerability_shared: { ternura: 0.05, vulnerabilidade: 0.04 },
      obligation_failed: { frustração: 0.06, stress: 0.05 },
      good_sleep: { alívio: 0.05, energia: 0.04 },
      bad_sleep: { exaustao: 0.05, irritação: 0.04 }
    };
    const trigger = map[type] ?? (emotion ? { [emotion]: intensity } : {});
    this.blends.applyTrigger(type, trigger);

    if (type === "positive_interaction") {
      this.state.social = clamp01(this.state.social + 0.05);
      this.state.stress = clamp01(this.state.stress - 0.03);
    }
    if (type === "negative_interaction") {
      this.state.social = clamp01(this.state.social - 0.04);
      this.state.irritability = clamp01(this.state.irritability + 0.05);
    }
    if (type === "good_sleep") this.state.energy = clamp01(this.state.energy + 0.08);
    if (type === "bad_sleep") this.state.energy = clamp01(this.state.energy - 0.1);

    this.syncMood();
    this.state.lastUpdated = new Date().toISOString();
    this.save();
    this.bus?.emit("emotion.changed", { snapshot: this.getSnapshot(), event });
    return this.getSnapshot();
  }

  syncMood() {
    const dom = this.blends.dominant(1)[0]?.name ?? "neutral";
    const vec = this.blends.vector();
    this.state.energy = clamp01(vec.arousal * 0.6 + this.state.energy * 0.4);
    this.state.focus = clamp01(this.state.focus * 0.9 + vec.dominance * 0.1);
    const moodMap = {
      alegria: "happy",
      diversão: "playful",
      hype: "excited",
      irritação: "irritated",
      melancolia: "sad",
      solidão: "lonely",
      tédio: "bored",
      ansiedade: "anxious"
    };
    this.state.mood = moodMap[dom] ?? (vec.valence > 0.6 ? "content" : vec.valence < 0.4 ? "low" : "neutral");
  }

  tick(context = {}) {
    const { hoursElapsed = 0.25, hourOfDay, activity, sleepQuality, stress, region, climateTags } = context;
    this.blends.tick(hoursElapsed);

    if (this.body) {
      const bodyResult = this.body.tick({ hoursElapsed, hourOfDay, activity });
      if (bodyResult.needsMeal) this.blends.reinforce("antecipação", 0.02);
      if (bodyResult.discomfort > 0.4) this.blends.reinforce("irritação", 0.02);
    }

    if (this.health) {
      const healthResult = this.health.tick({ hoursElapsed, sleepQuality, stress, region });
      if (healthResult.severitySum > 0.3) {
        this.state.energy = clamp01(this.state.energy - 0.05);
        this.blends.reinforce("desânimo", 0.02);
      }
      if (region && climateTags?.length) {
        this.health.tryRegionalTrigger(region, climateTags, context);
      }
    }

    this.state.stress = clamp01(this.state.stress + (sleepQuality < 0.4 ? 0.03 : -0.01));
    this.syncMood();
    this.state.lastUpdated = new Date().toISOString();
    this.save();
    this.bus?.emit("emotion.changed", { snapshot: this.getSnapshot() });
    return this.getSnapshot();
  }
}
