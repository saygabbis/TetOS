import { classifyAbsence } from "./absenceClassifier.js";

const NUDGE_INTENTS = {
  medium: "Sinalizar que faz pouco tempo e abrir espaço para o usuário responder.",
  long: "Reconhecer que sumiu um tempo e perguntar como a pessoa está.",
  very_long: "Reconhecer um hiato maior e abrir um retorno leve sem pressão."
};

const NEUTRAL_PREFIXES = ["oi", "opa", "eae"];

function pickFrom(list = []) {
  if (!list.length) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function buildText(absenceLabel, softened) {
  const intent = NUDGE_INTENTS[absenceLabel] ?? NUDGE_INTENTS.medium;
  const prefix = softened ? `${pickFrom(NEUTRAL_PREFIXES)}! ` : "";
  return `${prefix}[NUDGE] ${intent}`.trim();
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
      gapMs: absence.gapMs ?? 0,
      intent: NUDGE_INTENTS[absence.label] ?? NUDGE_INTENTS.medium
    };
  }
}
