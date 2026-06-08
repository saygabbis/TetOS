import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { contextualSeed, chance } from "../brain/rng.js";

const DEFAULT_STATE = {
  hunger: 0.35,
  thirst: 0.3,
  mealRhythm: { lastMealAt: null, nextMealEta: null, skippedMeals: 0 },
  vices: { coffee: 0.2, sweets: 0.15, scroll: 0.1 },
  physicalComfort: 0.7,
  lastTickAt: null
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export class BodyNeeds {
  constructor(path, { bus = null } = {}) {
    this.path = path;
    this.bus = bus;
    this.state = readJson(path, DEFAULT_STATE) ?? { ...DEFAULT_STATE };
    this.state.mealRhythm ??= { ...DEFAULT_STATE.mealRhythm };
    this.state.vices ??= { ...DEFAULT_STATE.vices };
  }

  save() {
    writeJson(this.path, this.state);
  }

  getState() {
    return { ...this.state };
  }

  ingest({ type = "snack", at = Date.now() } = {}) {
    const factor = type === "meal" ? 0.45 : type === "drink" ? 0.3 : 0.15;
    if (type === "drink") {
      this.state.thirst = clamp01(this.state.thirst - factor);
    } else {
      this.state.hunger = clamp01(this.state.hunger - factor);
      this.state.mealRhythm.lastMealAt = new Date(at).toISOString();
      if (type === "meal") this.state.mealRhythm.skippedMeals = 0;
    }
    this.save();
    this.bus?.emit("body.ingested", { type, state: this.getState() });
  }

  useVice(name, amount = 0.08) {
    const key = String(name ?? "").trim();
    if (!this.state.vices[key]) this.state.vices[key] = 0.1;
    this.state.vices[key] = clamp01(this.state.vices[key] + amount);
    if (key === "coffee") {
      this.state.thirst = clamp01(this.state.thirst + 0.05);
    }
    this.save();
  }

  tick({ hoursElapsed = 0.25, hourOfDay = new Date().getHours(), activity = "idle" } = {}) {
    const seed = contextualSeed([hourOfDay, activity, this.state.hunger]);
    const rate = hoursElapsed * (activity === "creative" ? 1.2 : 1);

    this.state.hunger = clamp01(this.state.hunger + rate * 0.08);
    this.state.thirst = clamp01(this.state.thirst + rate * 0.06);
    this.state.physicalComfort = clamp01(
      this.state.physicalComfort - rate * 0.03 + (activity === "rest" ? 0.04 : 0)
    );

    const mealHours = [8, 12, 19];
    if (mealHours.includes(hourOfDay) && this.state.hunger > 0.55) {
      this.state.mealRhythm.nextMealEta = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    }

    if (this.state.hunger > 0.85 && chance(seed, 0.12)) {
      this.bus?.emit("body.hungry", { hunger: this.state.hunger });
    }

    if (this.state.hunger > 0.75) {
      this.bus?.emit("body.craving", { item: "pão", hunger: this.state.hunger });
    }

    this.state.lastTickAt = new Date().toISOString();
    this.save();

    return {
      state: this.getState(),
      needsMeal: this.state.hunger > 0.7,
      needsDrink: this.state.thirst > 0.65,
      discomfort: clamp01(1 - this.state.physicalComfort)
    };
  }
}
