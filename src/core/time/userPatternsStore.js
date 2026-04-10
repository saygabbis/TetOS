import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = {
  activeHours: {},
  lastInteractionByDay: {}
};

function dayKeyFromTimestamp(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class UserPatternsStore {
  constructor(path) {
    this.path = path;
    this.state = readJson(path, DEFAULT_STATE) ?? DEFAULT_STATE;
    this.state.activeHours ??= {};
    this.state.lastInteractionByDay ??= {};
  }

  save() {
    writeJson(this.path, this.state);
  }

  recordInteraction(userId, timestamp = Date.now()) {
    const key = String(userId ?? "default");
    const date = new Date(timestamp);
    const hour = date.getHours();
    const dayKey = dayKeyFromTimestamp(timestamp);

    const active = this.state.activeHours[key] ?? {};
    active[hour] = (active[hour] ?? 0) + 1;
    this.state.activeHours[key] = active;

    const daily = this.state.lastInteractionByDay[key] ?? {};
    daily[dayKey] = date.toISOString();
    this.state.lastInteractionByDay[key] = daily;

    this.save();
  }

  getActiveHours(userId) {
    const key = String(userId ?? "default");
    return this.state.activeHours[key] ?? {};
  }

  getLastInteractionByDay(userId) {
    const key = String(userId ?? "default");
    return this.state.lastInteractionByDay[key] ?? {};
  }

  isLikelyActiveNow(userId, timestamp = Date.now()) {
    const active = this.getActiveHours(userId);
    const hour = new Date(timestamp).getHours();
    if (!Object.keys(active).length) return true;
    const hits = active[hour] ?? 0;
    const peak = Math.max(...Object.values(active));
    if (peak <= 0) return true;
    return hits / peak >= 0.35;
  }
}
