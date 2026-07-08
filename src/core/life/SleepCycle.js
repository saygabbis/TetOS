import { contextualSeed, chance, pick, seededRandom } from "../brain/rng.js";
import {
  getLocalHour,
  isInSleepWindow,
  isPastWakeTime,
  resolveSleepWindow
} from "./sleepSchedule.js";
import {
  isSleepDisturbanceEnabled,
  sleepDisturbanceThreshold,
  sleepTempWakeMs
} from "./sleepDisturbanceDetect.js";

const SLEEP_STATES = [
  "deep_sleep", "light_sleep", "drowsy", "awake", "wired",
  "overslept", "underslept", "jet_lagged", "nap", "insomnia", "restless", "groggy"
];

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function dayKeyFromDate(date = new Date(), timezone = "America/Sao_Paulo") {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export class SleepCycle {
  constructor(lifeStateStore, { bus = null, timezone = "America/Sao_Paulo" } = {}) {
    this.store = lifeStateStore;
    this.bus = bus;
    this.timezone = timezone;
  }

  get sleep() {
    return this.store.get().sleep;
  }

  isAsleep() {
    const s = this.sleep.state;
    return ["deep_sleep", "light_sleep", "drowsy", "nap", "insomnia", "restless"].includes(s);
  }

  isTemporarilyAwake() {
    const until = this.sleep.temporaryWakeUntil;
    return Boolean(until && Date.now() < Date.parse(until));
  }

  getSnapshot() {
    return {
      ...this.sleep,
      isAvailable: this.isAvailable(),
      isTemporarilyAwake: this.isTemporarilyAwake(),
      tempWakeGrogginess: this.sleep.tempWakeGrogginess ?? 0,
      tempWakeExtensionCount: this.sleep.tempWakeExtensionCount ?? 0,
      quality: clamp01(1 - (this.sleep.sleepDebt ?? 0))
    };
  }

  isAvailable() {
    if (this.isTemporarilyAwake()) return true;

    const s = this.sleep.state;
    if (this.isAsleep()) return false;
    if (s === "awake" && this.sleep.wakeDelayUntil) {
      return Date.now() >= Date.parse(this.sleep.wakeDelayUntil);
    }
    return (
      s === "awake" ||
      s === "wired" ||
      s === "overslept" ||
      s === "underslept" ||
      s === "groggy"
    );
  }

  checkTemporaryWake() {
    const until = this.sleep.temporaryWakeUntil;
    if (!until) return null;
    if (Date.now() < Date.parse(until)) return null;
    return this.endTemporaryWake();
  }

  /**
   * Acorda no susto por flood/CAPS/nome — disponível por poucos minutos, depois volta a dormir.
   */
  attemptDisturbanceWake({ score = 0, floodCount = 0 } = {}) {
    if (!isSleepDisturbanceEnabled()) return null;
    this.checkTemporaryWake();
    if (!this.isAsleep() && !this.isTemporarilyAwake()) return null;

    const threshold = sleepDisturbanceThreshold();
    const effectiveScore = score + (floodCount >= 6 ? 0.08 : 0);
    if (effectiveScore < threshold) return null;

    const tempMs = sleepTempWakeMs();
    const temporaryWakeUntil = new Date(Date.now() + tempMs).toISOString();
    const disturbanceCount = (this.sleep.disturbanceCount ?? 0) + 1;
    const sleepDebt = clamp01((this.sleep.sleepDebt ?? 0) + 0.1);
    const dayKey = dayKeyFromDate(new Date(), this.timezone);

    this.store.patch({
      sleep: {
        ...this.sleep,
        state: "drowsy",
        temporaryWakeUntil,
        tempWakeStartedAt: new Date().toISOString(),
        tempWakeExtensionCount: 0,
        tempWakeGrogginess: 0.22,
        disturbanceCount,
        lastDisturbedAt: new Date().toISOString(),
        disturbedNightKey: dayKey,
        sleepDebt
      }
    });

    this.bus?.emit("sleep.disturbed_wake", {
      score: effectiveScore,
      floodCount,
      temporaryWakeUntil,
      disturbanceCount
    });

    return {
      event: "disturbed_wake",
      temporaryWakeUntil,
      disturbanceCount,
      available: true
    };
  }

  endTemporaryWake() {
    if (!this.sleep.temporaryWakeUntil) return null;
    const state = pick(contextualSeed(["return_sleep"]), ["deep_sleep", "light_sleep", "drowsy"]);
    this.store.patch({
      sleep: {
        ...this.sleep,
        state,
        temporaryWakeUntil: null,
        tempWakeStartedAt: null,
        tempWakeExtensionCount: 0,
        tempWakeGrogginess: 0,
        lastSleepAt: new Date().toISOString()
      }
    });
    this.bus?.emit("sleep.disturbed_return", { state });
    return { event: "disturbed_return", state };
  }

  /**
   * Enquanto acordada no susto: cada msg do usuário renova o timer e aumenta a sonolência.
   */
  extendTemporaryWakeOnInteraction() {
    if (!this.isTemporarilyAwake()) return null;
    const tempMs = sleepTempWakeMs();
    const extensions = (this.sleep.tempWakeExtensionCount ?? 0) + 1;
    const grogginess = Math.min(1, 0.22 + extensions * 0.14);
    const sleepDebt = clamp01((this.sleep.sleepDebt ?? 0) + 0.035);
    const temporaryWakeUntil = new Date(Date.now() + tempMs).toISOString();
    const state = extensions >= 4 ? "drowsy" : this.sleep.state ?? "drowsy";

    this.store.patch({
      sleep: {
        ...this.sleep,
        state,
        temporaryWakeUntil,
        tempWakeExtensionCount: extensions,
        tempWakeGrogginess: grogginess,
        sleepDebt
      }
    });

    this.bus?.emit("sleep.temp_wake_extended", {
      extensions,
      grogginess,
      temporaryWakeUntil
    });

    return { extensions, grogginess, temporaryWakeUntil, state };
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
        wakeDelayUntil: null,
        temporaryWakeUntil: null
      }
    });
    this.bus?.emit("sleep.entered", { state, reason });
  }

  wake({
    quality = 0.6,
    missedAlarm = false,
    immediate = false,
    disturbed = false
  } = {}) {
    const hadDisturbance =
      disturbed || (this.sleep.disturbanceCount ?? 0) > 0 || Boolean(this.sleep.disturbedNightKey);

    let wakeDelayMin = immediate
      ? 0
      : 5 + Math.floor(seededRandom(contextualSeed(["wake"]))() * 35);

    if (hadDisturbance) {
      wakeDelayMin = immediate
        ? 0
        : Math.min(55, wakeDelayMin + 8 + Math.floor((this.sleep.disturbanceCount ?? 0) * 2));
    }

    const wakeDelayUntil = immediate
      ? null
      : new Date(Date.now() + wakeDelayMin * 60 * 1000).toISOString();

    let q = quality;
    if (hadDisturbance) q = Math.min(q, 0.34);

    let state = "awake";
    if (hadDisturbance) state = "groggy";
    else if (q < 0.4) state = "underslept";
    else if (q > 0.85) state = "overslept";

    let alarmMissed = missedAlarm;
    if (hadDisturbance && !alarmMissed) {
      const seed = contextualSeed([this.sleep.disturbanceCount, q]);
      alarmMissed = chance(seed, 0.07 + (this.sleep.disturbanceCount ?? 0) * 0.025);
    }
    if (alarmMissed) state = hadDisturbance ? "groggy" : "overslept";

    const sleepDebt = clamp01(
      (this.sleep.sleepDebt ?? 0) + (q < 0.5 || hadDisturbance ? 0.14 : -0.08)
    );

    this.store.patch({
      sleep: {
        ...this.sleep,
        state,
        lastWakeAt: new Date().toISOString(),
        wakeDelayUntil: hadDisturbance && state === "groggy" ? null : wakeDelayUntil,
        temporaryWakeUntil: null,
        sleepDebt,
        alarmHistory: [
          ...(this.sleep.alarmHistory ?? []).slice(-20),
          { ts: new Date().toISOString(), missedAlarm: alarmMissed, quality: q, state, disturbed: hadDisturbance }
        ]
      }
    });
    this.bus?.emit("sleep.wake", { state, missedAlarm: alarmMissed, wakeDelayMin, disturbed: hadDisturbance });
    if (alarmMissed) this.bus?.emit("sleep.missed_alarm", { state, disturbed: hadDisturbance });
    return { state, wakeDelayMin, availableAt: wakeDelayUntil, event: "wake", disturbed: hadDisturbance };
  }

  reconcileWithSchedule({ timezone = "America/Sao_Paulo", rhythm = {}, now = new Date() } = {}) {
    this.checkTemporaryWake();
    if (!this.isAsleep()) return null;
    const hour = getLocalHour(now, timezone);
    const window = resolveSleepWindow({ tonightPlan: this.sleep.tonightPlan, rhythm });
    if (!isInSleepWindow(hour, window.bedHour, window.wakeHour)) {
      const disturbed = (this.sleep.disturbanceCount ?? 0) > 0;
      return this.wake({ quality: disturbed ? 0.3 : 0.68, missedAlarm: false, immediate: true, disturbed });
    }
    if (isPastWakeTime(hour, window.bedHour, window.wakeHour)) {
      const disturbed = (this.sleep.disturbanceCount ?? 0) > 0;
      return this.wake({ quality: disturbed ? 0.28 : 0.62, missedAlarm: false, immediate: true, disturbed });
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
    this.checkTemporaryWake();

    const hour = hourOfDay ?? getLocalHour(now, timezone);
    const window = resolveSleepWindow({ tonightPlan: this.sleep.tonightPlan, rhythm });
    const { bedHour, wakeHour, peakHours } = window;
    const seed = contextualSeed([hour, this.sleep.state, energy, bedHour, wakeHour]);
    let event = null;

    if (this.sleep.state === "groggy" && !isInSleepWindow(hour, bedHour, wakeHour)) {
      const awakeHours = this.sleep.lastWakeAt
        ? (Date.now() - Date.parse(this.sleep.lastWakeAt)) / (60 * 60 * 1000)
        : 0;
      if (awakeHours > 4 && chance(seed, 0.35)) {
        this.store.patch({ sleep: { ...this.sleep, state: "awake", disturbanceCount: 0 } });
      }
    }

    if (!this.sleep.tonightPlan && hour >= 20 && hour <= 23) {
      this.planTonight({ hourOfDay: hour, energy, rhythm });
    }

    if (this.isAsleep()) {
      if (!isInSleepWindow(hour, bedHour, wakeHour) || isPastWakeTime(hour, bedHour, wakeHour)) {
        const disturbed = (this.sleep.disturbanceCount ?? 0) > 0;
        let missed = chance(seed, 0.04 + stress * 0.02);
        if (disturbed) missed = missed || chance(seed, 0.08 + (this.sleep.disturbanceCount ?? 0) * 0.02);
        const outsideWindow = !isInSleepWindow(hour, bedHour, wakeHour);
        event = this.wake({
          quality: clamp01(0.55 + (missed ? -0.15 : 0.12) - (disturbed ? 0.2 : 0)),
          missedAlarm: missed,
          immediate: outsideWindow,
          disturbed
        });
      }
    } else if (isInSleepWindow(hour, bedHour, wakeHour) && !isPastWakeTime(hour, bedHour, wakeHour)) {
      if (this.isTemporarilyAwake()) {
        // ainda no susto — não re-dorme aqui
      } else if (peakHours.includes(hour)) {
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
      isTemporarilyAwake: this.isTemporarilyAwake(),
      sleepDebt: this.sleep.sleepDebt ?? 0,
      disturbanceCount: this.sleep.disturbanceCount ?? 0,
      bedHour,
      wakeHour,
      localHour: hour,
      event
    };
  }
}

export { SLEEP_STATES };
