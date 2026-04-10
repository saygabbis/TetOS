import { classifyAbsence } from "./absenceClassifier.js";

const NUDGE_TEMPLATES = {
  medium: ["e aí, tudo certo por aí?"],
  long: ["faz um tempinho, como você tá?"],
  very_long: ["faz um tempinho... tudo bem por aí?"]
};

const NEUTRAL_PREFIXES = ["oi", "opa", "eae"];

function pickFrom(list = []) {
  if (!list.length) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function buildText(absenceLabel, softened) {
  const base = pickFrom(NUDGE_TEMPLATES[absenceLabel] ?? NUDGE_TEMPLATES.medium);
  if (!softened) return base;
  const prefix = pickFrom(NEUTRAL_PREFIXES);
  return `${prefix}! ${base}`.trim();
}

export class NudgeEngine {
  constructor({ timeStore, userPatterns, internalState }) {
    this.timeStore = timeStore;
    this.userPatterns = userPatterns;
    this.internalState = internalState;
  }

  shouldConsiderNudge(userId = "default") {
    const lastMessage = this.timeStore?.getLastMessage(userId);
    if (!lastMessage) return false;
    return true;
  }

  buildNudge(userId = "default", now = Date.now()) {
    if (!this.shouldConsiderNudge(userId)) return null;
    const lastMessage = this.timeStore?.getLastMessage(userId);
    const absence = classifyAbsence(lastMessage, now);
    if (absence.label === "short") return null;

    const social = this.internalState?.getState?.()?.social ?? 0.6;
    if (social < 0.35) return null;

    const likelyActive = this.userPatterns?.isLikelyActiveNow?.(userId, now) ?? true;
    const softened = !likelyActive;
    const text = buildText(absence.label, softened);
    if (!text) return null;

    return {
      text,
      absence: absence.label,
      softened,
      gapMs: absence.gapMs ?? 0
    };
  }
}
