import { LifeProfile } from "./lifeProfile.js";
import { LifeStateStore } from "./lifeState.js";
import { SleepCycle } from "./SleepCycle.js";
import { CreativeRoutineGenerator } from "./CreativeRoutineGenerator.js";
import { contextualSeed, pick, chance } from "../brain/rng.js";

const PHASE_BY_HOUR = [
  { from: 0, to: 5, phase: "madrugada" },
  { from: 5, to: 11, phase: "manha" },
  { from: 11, to: 17, phase: "tarde" },
  { from: 17, to: 22, phase: "noite" },
  { from: 22, to: 24, phase: "fim_de_noite" }
];

function resolvePhase(hour) {
  const match = PHASE_BY_HOUR.find((p) => hour >= p.from && hour < p.to);
  return match?.phase ?? "tarde";
}

export class LifeEngine {
  constructor({
    profilePath,
    statePath,
    bus = null,
    socialGraph = null,
    musicWorld = null,
    bodyNeeds = null,
    journalAppend = null,
    workerLlm = null
  } = {}) {
    this.profile = new LifeProfile(profilePath);
    this.store = new LifeStateStore(statePath);
    this.sleep = new SleepCycle(this.store, { bus });
    this.routine = new CreativeRoutineGenerator(this.store, this.profile, { bus, journalAppend, workerLlm });
    this.workerLlm = workerLlm;
    this.bus = bus;
    this.socialGraph = socialGraph;
    this.musicWorld = musicWorld;
    this.bodyNeeds = bodyNeeds;
  }

  getSnapshot() {
    return {
      ...this.store.get(),
      profile: { homeBase: this.profile.get().homeBase }
    };
  }

  pickActivity(phase, context = {}) {
    const seed = contextualSeed([phase, context.emotion?.mood, this.store.get().currentActivity]);
    const seeds = this.profile.seedsForPhase(phase);
    const musicActivity = this.musicWorld?.getCurrentActivity?.();
    const candidates = [...seeds];
    if (musicActivity) candidates.push(musicActivity);
    if (this.bodyNeeds?.getState?.().hunger > 0.7) candidates.push("comer algo");
    return pick(seed, candidates) ?? "descanso leve";
  }

  transitionActivity(phase, context = {}) {
    const activity = this.pickActivity(phase, context);
    const durationMin = 45 + (contextualSeed([activity]) % 135);
    this.store.setActivity(activity, { phase });
    this.bus?.emit("life.activity_changed", {
      activity,
      phase,
      durationMin,
      startedAt: this.store.get().activityStartedAt
    });
    return { activity, durationMin };
  }

  tick(context = {}) {
    const now = context.now ?? new Date();
    const hour = now.getHours();
    const phase = resolvePhase(hour);
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const state = this.store.get();

    const sleepResult = this.sleep.tick({
      hourOfDay: hour,
      energy: context.emotion?.energy ?? 0.5,
      stress: context.emotion?.stress ?? 0.3,
      jetLag: context.world?.climateTags?.includes("jet_lag")
    });

    if (this.bodyNeeds) {
      this.bodyNeeds.tick({ hourOfDay: hour, activity: state.currentActivity ?? "idle" });
    }

    if (this.socialGraph && sleepResult.isAvailable) {
      this.socialGraph.tick({ hourOfDay: hour, emotion: context.emotion, availability: "awake" });
    }

    if (this.musicWorld && sleepResult.isAvailable) {
      this.musicWorld.tick({ phase, emotion: context.emotion });
    }

    const startedAt = state.activityStartedAt ? Date.parse(state.activityStartedAt) : null;
    const elapsedMin = startedAt ? (now.getTime() - startedAt) / 60000 : Infinity;
    const shouldTransition = !state.currentActivity || elapsedMin > 90;

    if (sleepResult.isAvailable && shouldTransition && chance(contextualSeed([phase, hour]), 0.35)) {
      this.transitionActivity(phase, context);
    } else if (!sleepResult.isAvailable && state.currentActivity) {
      this.store.clearActivity();
    }

    void this.routine.tick({
      phase,
      isWeekend,
      snapshot: { emotion: context.emotion, life: state, music: this.musicWorld?.getSnapshot?.() },
      useLlm: Boolean(this.workerLlm?.generate) && phase === "manha"
    });
    this.store.patch({ phase, dayKey: now.toISOString().slice(0, 10), lastTickAt: now.toISOString() });

    return {
      ...this.getSnapshot(),
      sleep: sleepResult,
      phase,
      isWeekend
    };
  }
}
