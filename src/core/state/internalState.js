import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = {
  mood: "neutral",
  energy: 0.7,
  social: 0.6,
  focus: 0.5,
  lastInteraction: null,
  recentInteractions: []
};

const POSITIVE_HINTS = ["valeu", "obrig", "gostei", "legal", "massa", "boa", "perfeito", "amei"];
const NEGATIVE_HINTS = ["ruim", "triste", "chato", "cansad", "borocoxo", "desanim", "nada a ver", "estranho"];

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const normalize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const classifySentiment = (text) => {
  const t = normalize(text);
  if (POSITIVE_HINTS.some((term) => t.includes(term))) return "positive";
  if (NEGATIVE_HINTS.some((term) => t.includes(term))) return "negative";
  return "neutral";
};

const pickMood = (state, sentiment, styleHint) => {
  if (sentiment === "negative") return "sad";
  if (sentiment === "positive" && (styleHint?.userLaughterEnergy === "high" || styleHint?.userMessyLaughter)) {
    return "playful";
  }
  if (sentiment === "positive") return "happy";
  if (state.energy < 0.35) return "tired";
  if (styleHint?.userLaughterEnergy === "high") return "playful";
  return "neutral";
};

export class InternalState {
  constructor(path) {
    this.path = path;
    this.state = readJson(path, DEFAULT_STATE) ?? DEFAULT_STATE;
  }

  getState() {
    return this.state;
  }

  save() {
    writeJson(this.path, this.state);
  }

  updateBefore(message, meta = {}) {
    const now = Date.now();
    const last = this.state.lastInteraction ? new Date(this.state.lastInteraction).getTime() : null;
    const gapMs = last ? now - last : null;
    const styleHint = meta?.styleHint ?? {};
    const sentiment = classifySentiment(message);

    if (gapMs !== null) {
      if (gapMs > 1000 * 60 * 60) {
        this.state.social = clamp01(this.state.social - 0.12);
        this.state.energy = clamp01(this.state.energy - 0.08);
        this.state.focus = clamp01(this.state.focus - 0.05);
      } else if (gapMs < 1000 * 60 * 3) {
        this.state.social = clamp01(this.state.social + 0.06);
      }
    }

    if (styleHint.userMessageMessy || styleHint.userKeyboardSmash) {
      this.state.energy = clamp01(this.state.energy - 0.03);
    }

    if (styleHint.userLaughterEnergy === "high" || styleHint.userMessyLaughter) {
      this.state.energy = clamp01(this.state.energy + 0.03);
      this.state.social = clamp01(this.state.social + 0.02);
    }

    if (sentiment === "positive") {
      this.state.energy = clamp01(this.state.energy + 0.04);
      this.state.social = clamp01(this.state.social + 0.05);
    } else if (sentiment === "negative") {
      this.state.social = clamp01(this.state.social - 0.04);
      this.state.energy = clamp01(this.state.energy - 0.03);
    }

    this.state.mood = pickMood(this.state, sentiment, styleHint);
    this.state.lastInteraction = new Date(now).toISOString();

    this.state.recentInteractions.push({
      type: "user",
      sentiment,
      length: String(message ?? "").length,
      timestamp: this.state.lastInteraction
    });
    if (this.state.recentInteractions.length > 20) {
      this.state.recentInteractions = this.state.recentInteractions.slice(-20);
    }

    this.save();
    return this.state;
  }

  updateAfter(reply) {
    const text = String(reply ?? "");
    const sentiment = classifySentiment(text);

    this.state.energy = clamp01(this.state.energy - 0.015);
    this.state.focus = clamp01(this.state.focus + (text.length > 120 ? 0.03 : 0.01));
    if (sentiment === "positive") {
      this.state.social = clamp01(this.state.social + 0.02);
    }

    this.state.recentInteractions.push({
      type: "assistant",
      sentiment,
      length: text.length,
      timestamp: new Date().toISOString()
    });
    if (this.state.recentInteractions.length > 20) {
      this.state.recentInteractions = this.state.recentInteractions.slice(-20);
    }

    this.save();
    return this.state;
  }
}
