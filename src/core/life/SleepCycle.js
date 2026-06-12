import { contextualSeed, chance, pick, seededRandom } from "../brain/rng.js";

const SLEEP_STATES = [
  "deep_sleep", "light_sleep", "drowsy", "awake", "wired",
  "overslept", "underslept", "jet_lagged", "nap", "insomnia", "restless"
];

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export class SleepCycle {
  constructor(lifeStateStore, { bus = null } = {}) {
    this.store = lifeStateStore;
    this.bus = bus;
  }

  get sleep() {
    return this.store.get().sleep;
  }

  isAsleep() {
    const s = this.sleep.state;
    return ["deep_sleep", "light_sleep", "drowsy", "nap", "insomnia", "restless"].includes(s);
  }

  getSnapshot() {
    return {
      ...this.sleep,
      isAvailable: this.isAvailable(),
      quality: clamp01(1 - (this.sleep.sleepDebt ?? 0))
    };
  }

  isAvailable() {
    const s = this.sleep.state;
    if (this.isAsleep()) return false;
    if (s === "awake" && this.sleep.wakeDelayUntil) {
      return Date.now() >= Date.parse(this.sleep.wakeDelayUntil);
    }
    return s === "awake" || s === "wired" || s === "overslept" || s === "underslept";
  }

  planTonight({ hourOfDay = 22, energy = 0.5, obligations = [] } = {}) {
    const seed = contextualSeed([hourOfDay, energy, obligations.length]);
    const rand = seededRandom(seed);
    const baseBedHour = 23 + Math.floor(rand() * 3);
    const wakeHour = 7 + Math.floor(rand() * 4);
    const plan = {
      bedHour: baseBedHour % 24,
      wakeHour,
      alarmSet: true,
      qualityTarget: clamp01(0.55 + (energy < 0.3 ? -0.1 : 0.05))
    };
    this.store.patch({
      sleep: { ...this.sleep, tonightPlan: plan }
    });
    return plan;
  }

  goToSleep(reason = "scheduled") {
    const state = pick(contextualSeed([reason]), ["deep_sleep", "light_sleep", "drowsy"]);
    this.store.patch({
      sleep: {
        ...this.sleep,
        state,
        lastSleepAt: new Date().toISOString(),
        wakeDelayUntil: null
      }
    });
    this.bus?.emit("sleep.entered", { state, reason });
  }

  wake({ quality = 0.6, missedAlarm = false } = {}) {
    const wakeDelayMin = 5 + Math.floor(seededRandom(contextualSeed(["wake"]))() * 35);
    const wakeDelayUntil = new Date(Date.now() + wakeDelayMin * 60 * 1000).toISOString();
    let state = "awake";
    if (quality < 0.4) state = "underslept";
    if (quality > 0.85) state = "overslept";
    if (missedAlarm) state = "overslept";

    const sleepDebt = clamp01((this.sleep.sleepDebt ?? 0) + (quality < 0.5 ? 0.12 : -0.08));

    this.store.patch({
      sleep: {
        ...this.sleep,
        state,
        lastWakeAt: new Date().toISOString(),
        wakeDelayUntil,
        sleepDebt,
        alarmHistory: [
          ...(this.sleep.alarmHistory ?? []).slice(-20),
          { ts: new Date().toISOString(), missedAlarm, quality, state }
        ]
      }
    });
    this.bus?.emit("sleep.wake", { state, missedAlarm, wakeDelayMin });
    if (missedAlarm) this.bus?.emit("sleep.missed_alarm", { state });
    return { state, wakeDelayMin, availableAt: wakeDelayUntil };
  }

  tick({ hourOfDay = new Date().getHours(), energy = 0.5, stress = 0.3, jetLag = false } = {}) {
    const seed = contextualSeed([hourOfDay, this.sleep.state, energy]);
    const plan = this.sleep.tonightPlan;
    let event = null;

    if (this.isAsleep() && (plan?.wakeHour === hourOfDay || (hourOfDay >= 7 && hourOfDay <= 11))) {
      const missed = chance(seed, 0.05 + stress * 0.03);
      event = this.wake({ quality: clamp01(0.5 + (missed ? -0.2 : 0.1)), missedAlarm: missed });
    } else if (!this.isAsleep() && (plan?.bedHour === hourOfDay || hourOfDay >= 23 || hourOfDay < 6)) {
      if (energy > 0.8 && hourOfDay < 23 && chance(seed, 0.15)) {
        this.store.patch({ sleep: { ...this.sleep, state: "wired" } });
      } else if (chance(seed, hourOfDay >= 23 || hourOfDay < 6 ? 0.92 : 0.55)) {
        this.goToSleep(plan?.bedHour === hourOfDay ? "scheduled" : "night_hours");
      }
    }

    if (jetLag && !this.sleep.state.includes("jet")) {
      this.store.patch({ sleep: { ...this.sleep, state: "jet_lagged" } });
    }

    return {
      state: this.sleep.state,
      isAsleep: this.isAsleep(),
      isAvailable: this.isAvailable(),
      sleepDebt: this.sleep.sleepDebt ?? 0,
      event
    };
  }
}

export { SLEEP_STATES };
