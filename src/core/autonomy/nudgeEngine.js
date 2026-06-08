import { classifyAbsence } from "./absenceClassifier.js";

const NUDGE_INTENTS = {
  medium: "Sinalizar que faz pouco tempo e abrir espaço para o usuário responder.",
  long: "Reconhecer que sumiu um tempo e perguntar como a pessoa está.",
  very_long: "Reconhecer um hiato maior e abrir um retorno leve sem pressão."
};

export class NudgeEngine {
  constructor({ timeStore, userPatterns, internalState, brainOrchestrator = null }) {
    this.timeStore = timeStore;
    this.userPatterns = userPatterns;
    this.internalState = internalState;
    this.brainOrchestrator = brainOrchestrator;
  }

  shouldConsiderNudge(userId = "default") {
    const lastMessage = this.timeStore?.getLastMessage(userId);
    if (!lastMessage) return false;
    return true;
  }

  buildBrainContext(userId = "default") {
    if (!this.brainOrchestrator) return null;
    const hour = new Date().getHours();
    const emotion = this.brainOrchestrator.emotion?.getSnapshot?.() ?? this.internalState?.getState?.() ?? {};
    const trustBond = this.brainOrchestrator.enrichTrustForTiming?.(userId, "direct", emotion, hour) ?? null;
    const plan = this.brainOrchestrator.timing?.computePlan?.({
      userId,
      channelScope: "direct",
      hourOfDay: hour,
      emotion,
      lastMessageAt: this.timeStore?.getLastMessage?.(userId) ?? null,
      userLikelyActive: this.userPatterns?.isLikelyActiveNow?.(userId) ?? true,
      trustBond,
      life: this.brainOrchestrator.life?.getSnapshot?.() ?? {},
      sleep: this.brainOrchestrator.life?.sleep?.getSnapshot?.() ?? {}
    });
    const blocks = this.brainOrchestrator.narrator?.buildBlocks?.({
      emotion,
      life: this.brainOrchestrator.life?.getSnapshot?.() ?? {},
      trustBond,
      timing: plan
    }) ?? {};
    return { plan, blocks, trustBond, emotion };
  }

  buildNudge(userId = "default", now = Date.now()) {
    if (!this.shouldConsiderNudge(userId)) return null;
    const lastMessage = this.timeStore?.getLastMessage(userId);
    const absence = classifyAbsence(lastMessage, now);
    if (absence.label === "short") return null;

    const brainCtx = this.buildBrainContext(userId);
    const social = brainCtx?.emotion?.social ?? this.internalState?.getState?.()?.social ?? 0.6;
    if (social < 0.35) return null;

    const likelyActive = this.userPatterns?.isLikelyActiveNow?.(userId, now) ?? true;
    const softened = !likelyActive;
    const intent = NUDGE_INTENTS[absence.label] ?? NUDGE_INTENTS.medium;

    return {
      text: null,
      intent,
      absence: absence.label,
      softened,
      gapMs: absence.gapMs ?? 0,
      timingPlan: brainCtx?.plan ?? null,
      brainBlocks: brainCtx?.blocks ?? null,
      distanceContext: brainCtx?.plan?.distanceContext ?? ""
    };
  }
}
