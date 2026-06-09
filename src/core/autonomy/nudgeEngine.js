import { InitiationEngine } from "./initiationEngine.js";

/** @deprecated use InitiationEngine — mantido como alias fino para o runner. */
export class NudgeEngine extends InitiationEngine {
  buildNudge(userId = "default", now = Date.now()) {
    const evaluation = this.evaluateForUser(userId, now);
    if (!evaluation?.shouldInitiate) return null;

    return {
      text: null,
      intent: null,
      evaluation,
      absence: evaluation.absence,
      gapMs: evaluation.gapMs,
      timingPlan: evaluation.timingPlan,
      brainBlocks: evaluation.brainBlocks
    };
  }
}
