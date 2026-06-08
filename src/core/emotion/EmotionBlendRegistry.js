import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { contextualSeed, seededRandom } from "../brain/rng.js";

const DEFAULT_BLENDS = {
  alegria: 0.12,
  ternura: 0.08,
  tédio: 0.05,
  nostalgia: 0.06,
  irritação: 0.04,
  ansiedade: 0.03,
  melancolia: 0.04,
  hype: 0.06,
  gratidão: 0.05,
  solidão: 0.03,
  vergonha: 0.02,
  orgulho: 0.04,
  antecipação: 0.05,
  frustração: 0.03,
  carinho: 0.07,
  diversão: 0.08,
  desânimo: 0.02,
  alívio: 0.04,
  ressentimento: 0.01,
  esperança: 0.05
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export class EmotionBlendRegistry {
  constructor(path) {
    this.path = path;
    this.data = readJson(path, { blends: { ...DEFAULT_BLENDS }, inertia: 0.85 }) ?? {
      blends: { ...DEFAULT_BLENDS },
      inertia: 0.85
    };
    this.data.blends ??= { ...DEFAULT_BLENDS };
    this.data.inertia ??= 0.85;
    this.normalize();
  }

  save() {
    writeJson(this.path, this.data);
  }

  getBlends() {
    return { ...this.data.blends };
  }

  normalize() {
    const total = Object.values(this.data.blends).reduce((sum, w) => sum + w, 0) || 1;
    for (const key of Object.keys(this.data.blends)) {
      this.data.blends[key] = this.data.blends[key] / total;
    }
  }

  dominant(limit = 3) {
    return Object.entries(this.data.blends)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, weight]) => ({ name, weight }));
  }

  reinforce(emotion, amount = 0.04) {
    const key = String(emotion ?? "").trim();
    if (!key) return;
    if (!this.data.blends[key]) {
      this.data.blends[key] = 0.01;
    }
    const inertia = this.data.inertia;
    for (const name of Object.keys(this.data.blends)) {
      const decay = name === key ? 0 : amount * 0.35;
      this.data.blends[name] = clamp01(this.data.blends[name] * inertia - decay + (name === key ? amount : 0));
    }
    this.normalize();
    this.save();
  }

  applyTrigger(trigger, deltaMap = {}) {
    const map = deltaMap[trigger] ?? deltaMap.default ?? {};
    for (const [emotion, delta] of Object.entries(map)) {
      if (!this.data.blends[emotion]) this.data.blends[emotion] = 0.01;
      this.data.blends[emotion] = clamp01(this.data.blends[emotion] + delta);
    }
    this.normalize();
    this.save();
  }

  decay(hours = 1, seedParts = []) {
    const seed = contextualSeed(seedParts);
    const rand = seededRandom(seed);
    const rate = clamp01(0.02 * hours + rand() * 0.01);
    for (const name of Object.keys(this.data.blends)) {
      const target = DEFAULT_BLENDS[name] ?? 0.02;
      this.data.blends[name] = clamp01(this.data.blends[name] + (target - this.data.blends[name]) * rate);
    }
    this.normalize();
    this.save();
  }

  vector() {
    const blends = this.getBlends();
    let valence = 0;
    let arousal = 0;
    const positive = ["alegria", "ternura", "hype", "gratidão", "carinho", "diversão", "orgulho", "esperança", "alívio"];
    const negative = ["irritação", "ansiedade", "melancolia", "solidão", "vergonha", "frustração", "desânimo", "ressentimento"];
    const highArousal = ["hype", "irritação", "ansiedade", "diversão", "antecipação"];
    for (const [name, weight] of Object.entries(blends)) {
      if (positive.includes(name)) valence += weight;
      if (negative.includes(name)) valence -= weight;
      if (highArousal.includes(name)) arousal += weight;
    }
    return {
      valence: clamp01((valence + 1) / 2),
      arousal: clamp01(arousal * 2),
      dominance: clamp01(0.5 + (blends.orgulho ?? 0) - (blends.vergonha ?? 0))
    };
  }

  tick(hoursElapsed = 0.25) {
    this.decay(hoursElapsed);
    return { blends: this.getBlends(), dominant: this.dominant(), vector: this.vector() };
  }
}
