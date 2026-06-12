import { contextualSeed, chance, pick, seededRandom } from "../brain/rng.js";
import {
  getLocalHour,
  isInSleepWindow,
  isPastWakeTime,
  resolveSleepWindow
} from "./sleepSchedule.js";

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

  planTonight({ hourOfDay = 22, energy = 0.5, obligations = [], rhythm = {} } = {}) {
    const resolved = resolveSleepWindow({ tonightPlan: null, rhythm });
    const seed = contextualSeed([hourOfDay, energy, obligations.length]);
    const rand = seededRandom(seed);
    const bedJitter = Math.floor(rand() * 2);
    const wakeJitter = Math.floor(rand() * 2);
    const plan = {
      bedHour: Math.min(23, resolved.bedHour + bedJitter),
      wakeHour: Math.max(6, resolved.wakeHour + wakeJitter),
      alarmSet: true,
      qualityTarget: clamp01(0.55 + (energy < 0.3 ? -0.1 : 0.05)),
      source: resolved.peakHours?.length ? "rhythm" : "default"
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

  wake({ quality = 0.6, missedAlarm = false, immediate = false } = {}) {
    const wakeDelayMin = immediate
      ? 0
      : 5 + Math.floor(seededRandom(contextualSeed(["wake"]))() * 35);
    const wakeDelayUntil = immediate
      ? null
      : new Date(Date.now() + wakeDelayMin * 60 * 1000).toISOString();
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
    return { state, wakeDelayMin, availableAt: wakeDelayUntil, event: "wake" };
  }

  /**
   * Ao ligar o bot ou receber tick: se está dormindo fora da janela (ex. 13h), acorda.
   */
  reconcileWithSchedule({ timezone = "America/Sao_Paulo", rhythm = {}, now = new Date() } = {}) {
    if (!this.isAsleep()) return null;
    const hour = getLocalHour(now, timezone);
    const window = resolveSleepWindow({ tonightPlan: this.sleep.tonightPlan, rhythm });
    if (!isInSleepWindow(hour, window.bedHour, window.wakeHour)) {
      return this.wake({ quality: 0.68, missedAlarm: false, immediate: true });
    }
    if (isPastWakeTime(hour, window.bedHour, window.wakeHour)) {
      return this.wake({ quality: 0.62, missedAlarm: false, immediate: true });
    }
    return null;
  }

  tick({
    hourOfDay,
    timezone = "America/Sao_Paulo",
    rhythm = {},
    now = new Date(),
    energy = 0.5,
    stress = 0.3,
    jetLag = false
  } = {}) {
    const hour = hourOfDay ?? getLocalHour(now, timezone);
    const window = resolveSleepWindow({ tonightPlan: this.sleep.tonightPlan, rhythm });
    const { bedHour, wakeHour, peakHours } = window;
    const seed = contextualSeed([hour, this.sleep.state, energy, bedHour, wakeHour]);
    let event = null;

    if (!this.sleep.tonightPlan && hour >= 20 && hour <= 23) {
      this.planTonight({ hourOfDay: hour, energy, rhythm });
    }

    if (this.isAsleep()) {
      if (!isInSleepWindow(hour, bedHour, wakeHour) || isPastWakeTime(hour, bedHour, wakeHour)) {
        const missed = chance(seed, 0.04 + stress * 0.02);
        const outsideWindow = !isInSleepWindow(hour, bedHour, wakeHour);
        event = this.wake({
          quality: clamp01(0.55 + (missed ? -0.15 : 0.12)),
          missedAlarm: missed,
          immediate: outsideWindow
        });
      }
    } else if (isInSleepWindow(hour, bedHour, wakeHour) && !isPastWakeTime(hour, bedHour, wakeHour)) {
      if (peakHours.includes(hour)) {
        if (energy > 0.75 && chance(seed, 0.2)) {
          this.store.patch({ sleep: { ...this.sleep, state: "wired" } });
        }
      } else if (energy > 0.88 && hour < bedHour && chance(seed, 0.12)) {
        this.store.patch({ sleep: { ...this.sleep, state: "wired" } });
      } else if (chance(seed, hour >= bedHour || hour < 4 ? 0.88 : 0.45)) {
        this.goToSleep(this.sleep.tonightPlan?.bedHour === hour ? "scheduled" : "night_hours");
      }
    }

    if (jetLag && !String(this.sleep.state).includes("jet")) {
      this.store.patch({ sleep: { ...this.sleep, state: "jet_lagged" } });
    }

    return {
      state: this.sleep.state,
      isAsleep: this.isAsleep(),
      isAvailable: this.isAvailable(),
      sleepDebt: this.sleep.sleepDebt ?? 0,
      bedHour,
      wakeHour,
      localHour: hour,
      event
    };
  }
}

export { SLEEP_STATES };
