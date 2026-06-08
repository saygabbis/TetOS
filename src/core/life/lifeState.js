import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = {
  currentActivity: null,
  activityStartedAt: null,
  phase: "manha",
  obligations: [],
  hobbies: [],
  chores: [],
  goals: [],
  privateThoughts: [],
  sleep: {
    state: "awake",
    sleepDebt: 0,
    lastSleepAt: null,
    lastWakeAt: null,
    tonightPlan: null,
    alarmHistory: []
  },
  lastTickAt: null,
  dayKey: null
};

export function loadLifeState(path) {
  const state = readJson(path, DEFAULT_STATE) ?? structuredClone(DEFAULT_STATE);
  state.sleep ??= { ...DEFAULT_STATE.sleep };
  state.obligations ??= [];
  state.hobbies ??= [];
  state.chores ??= [];
  state.goals ??= [];
  state.privateThoughts ??= [];
  return state;
}

export class LifeStateStore {
  constructor(path) {
    this.path = path;
    this.state = loadLifeState(path);
  }

  get() {
    return this.state;
  }

  save() {
    writeJson(this.path, this.state);
  }

  setActivity(activity, meta = {}) {
    this.state.currentActivity = activity;
    this.state.activityStartedAt = new Date().toISOString();
    if (meta.phase) this.state.phase = meta.phase;
    this.save();
  }

  clearActivity() {
    this.state.currentActivity = null;
    this.state.activityStartedAt = null;
    this.save();
  }

  patch(partial) {
    Object.assign(this.state, partial);
    this.state.lastTickAt = new Date().toISOString();
    this.save();
    return this.state;
  }

  appendPrivateThought(text, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      text: String(text ?? "").slice(0, 500),
      ...meta
    };
    this.state.privateThoughts.push(entry);
    if (this.state.privateThoughts.length > 100) {
      this.state.privateThoughts = this.state.privateThoughts.slice(-100);
    }
    this.save();
    return entry;
  }
}
