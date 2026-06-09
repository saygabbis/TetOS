import { contextualSeed, chance, seededRandom } from "../brain/rng.js";
import { applyExtendedChecks } from "./timingChecks.js";

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export class TimingEngine {
  constructor({ enabled = true, absorbedPatterns = null, getAbsorbedPatterns = null, behaviorProfiler = null, behaviorProfiles = null } = {}) {
    this.enabled = enabled;
    this.absorbedPatterns = absorbedPatterns;
    this.getAbsorbedPatterns = getAbsorbedPatterns;
    this.behaviorProfiler = behaviorProfiler ?? behaviorProfiles;
  }

  resolveAbsorbed(ctx) {
    if (typeof this.getAbsorbedPatterns === "function") return this.getAbsorbedPatterns();
    return this.absorbedPatterns ?? ctx.absorbed ?? {};
  }

  computePlan(context = {}) {
    const reasons = [];
    const plan = {
      readDelayMs: 400,
      thinkDelayMs: 1200,
      typingProfile: "normal",
      shouldInitiateConversation: false,
      initiateReason: null,
      silenceAppropriate: false,
      distanceContext: "",
      humanLatencyTargetMs: 4500,
      reasons: []
    };

    if (!this.enabled) {
      plan.reasons.push("engine_disabled");
      return plan;
    }

    this.stageAvailabilityGate(plan, context, reasons);
    this.stageDistanceAnalyzer(plan, context, reasons);
    this.stageRhythmMatcher(plan, context, reasons);
    this.stageEmotionalModulator(plan, context, reasons);
    this.stageBodyModulator(plan, context, reasons);
    this.stageContextWeight(plan, context, reasons);
    this.stageInitiationScorer(plan, context, reasons);
    applyExtendedChecks(plan, {
      ...context,
      absorbed: this.resolveAbsorbed(context),
      behaviorProfile: context.behaviorProfile ?? this.behaviorProfiler?.snapshot?.() ?? {},
      mediaTimingHint: context.mediaTimingHint ?? null,
      closeDecision: context.closeDecision ?? null
    }, reasons);
    this.stageDelayComposer(plan, context, reasons);
    this.stageSilenceJudge(plan, context, reasons);

    plan.humanLatencyTargetMs = plan.readDelayMs + plan.thinkDelayMs + (plan.typingDelayMs ?? 800);
    plan.reasons = reasons;
    return plan;
  }

  stageAvailabilityGate(plan, ctx, reasons) {
    const sleep = ctx.sleep ?? ctx.life?.sleep ?? {};
    if (["deep_sleep", "light_sleep", "nap"].includes(sleep.state)) {
      plan.silenceAppropriate = true;
      plan.readDelayMs = 0;
      plan.thinkDelayMs = 0;
      reasons.push("sleeping");
    }
    if (sleep.wakeDelayUntil && Date.now() < Date.parse(sleep.wakeDelayUntil)) {
      plan.readDelayMs += 60000;
      plan.thinkDelayMs += 30000;
      reasons.push("just_woke_up");
    }
    if (ctx.life?.currentActivity?.includes("ensaio")) {
      plan.readDelayMs += 2000;
      reasons.push("busy_rehearsal");
    }
    if ((ctx.health ?? []).some((h) => h.severity > 0.5)) {
      plan.thinkDelayMs += 800;
      reasons.push("unwell");
    }
  }

  stageDistanceAnalyzer(plan, ctx, reasons) {
    const lastAt = ctx.lastUserMessageAt
      ? Date.parse(ctx.lastUserMessageAt)
      : ctx.lastMessageAt
        ? Date.parse(ctx.lastMessageAt)
        : null;
    const gapMs = lastAt ? Date.now() - lastAt : null;
    if (gapMs === null) {
      plan.distanceContext = "primeira interação";
      reasons.push("first_contact");
      return;
    }
    const gapH = gapMs / (60 * 60 * 1000);
    if (gapH < 0.05) {
      plan.distanceContext = "burst imediato";
      plan.readDelayMs += 200;
      reasons.push("burst");
    } else if (gapH < 3) {
      plan.distanceContext = `${Math.round(gapH * 60)}min desde última msg`;
      reasons.push("short_gap");
    } else if (gapH < 24) {
      plan.distanceContext = `${gapH.toFixed(1)}h desde última msg, medium gap`;
      plan.thinkDelayMs += 400;
      reasons.push("medium_gap");
    } else {
      plan.distanceContext = `${Math.round(gapH)}h desde última msg, long gap`;
      plan.thinkDelayMs += 1200;
      plan.readDelayMs += 600;
      reasons.push("long_gap");
    }
  }

  stageRhythmMatcher(plan, ctx, reasons) {
    const hour = ctx.hourOfDay ?? new Date().getHours();
    const absorbed = this.resolveAbsorbed(ctx);
    const peaks = absorbed.rhythm?.peakHours ?? [];
    const quiet = absorbed.rhythm?.quietHours ?? [];
    if (peaks.includes(hour)) {
      plan.thinkDelayMs *= 0.85;
      reasons.push("user_peak_hour");
    }
    if (quiet.includes(hour)) {
      plan.thinkDelayMs *= 1.2;
      plan.readDelayMs += 500;
      reasons.push("quiet_hours");
    }
    const avg = absorbed.rhythm?.avgResponseMs ?? ctx.behaviorProfile?.avgLatencyMs;
    if (avg && avg > 3000) {
      plan.humanLatencyTargetMs = avg;
      reasons.push("calibrated_avg_latency");
    }
  }

  stageEmotionalModulator(plan, ctx, reasons) {
    const emotion = ctx.emotion ?? {};
    if (emotion.mood === "excited" || emotion.mood === "playful") {
      plan.thinkDelayMs *= 0.75;
      plan.typingProfile = "energetic";
      reasons.push("animated");
    }
    if (emotion.mood === "sad" || emotion.mood === "low") {
      plan.thinkDelayMs *= 1.3;
      plan.typingProfile = "slow";
      reasons.push("low_mood");
    }
    if (emotion.mood === "irritated") {
      plan.thinkDelayMs *= 0.9;
      plan.typingProfile = "terse";
      reasons.push("irritated");
    }
    if ((emotion.energy ?? 0.5) < 0.35) {
      plan.thinkDelayMs += 600;
      plan.typingProfile = "drowsy";
      reasons.push("low_energy");
    }
    if (sleepState(ctx) === "underslept") {
      plan.thinkDelayMs += 900;
      reasons.push("underslept");
    }
  }

  stageBodyModulator(plan, ctx, reasons) {
    const body = ctx.body ?? ctx.emotion?.body ?? {};
    if (body.hunger > 0.75) {
      plan.thinkDelayMs += 500;
      reasons.push("hungry");
    }
    if ((body.vices?.coffee ?? 0) > 0.5) {
      plan.thinkDelayMs *= 0.9;
      reasons.push("caffeinated");
    }
    if (body.physicalComfort < 0.4) {
      plan.thinkDelayMs += 400;
      reasons.push("physical_discomfort");
    }
  }

  stageContextWeight(plan, ctx, reasons) {
    if (ctx.isGroup) {
      plan.readDelayMs += 300;
      plan.typingProfile = "group_casual";
      reasons.push("group_context");
    }
    if (ctx.hasMedia) {
      plan.readDelayMs += 1500;
      reasons.push("quoted_media");
    }
    if (ctx.isDirectQuestion) {
      plan.thinkDelayMs += 300;
      reasons.push("direct_question");
    }
    if (ctx.isMention || ctx.isReply) {
      plan.readDelayMs += 200;
      reasons.push("addressed_directly");
    }
  }

  stageInitiationScorer(plan, ctx, reasons) {
    const trust = ctx.trustBond ?? {};
    const gapMs =
      ctx.gapSinceUserMs ??
      (ctx.lastUserMessageAt
        ? Date.now() - Date.parse(ctx.lastUserMessageAt)
        : ctx.lastMessageAt
          ? Date.now() - Date.parse(ctx.lastMessageAt)
          : null);
    const gapH = gapMs !== null ? gapMs / (60 * 60 * 1000) : 48;
    const gapMin = gapMs !== null ? gapMs / 60_000 : 999;
    const seed = contextualSeed([gapH, trust.intimacy, ctx.emotion?.mood, ctx.queuedMode]);
    const social = (ctx.emotion?.social ?? 0.5) + (trust.intimacy ?? 0) * 0.3;
    const subconscious = ctx.subconscious?.includes?.("pendência") ?? false;
    const energy = ctx.emotion?.energy ?? 0.5;
    const playful = ctx.emotion?.playfulness ?? ctx.emotion?.mood === "playful" ? 0.7 : 0.4;
    const trailingBot = ctx.trailingBotTurns ?? ctx.ghosting?.trailingBot ?? 0;
    const topicClosed = ctx.topicClosed ?? ctx.ghosting?.topicClosed ?? false;

    if (trailingBot >= 1 && gapMin < 90) {
      reasons.push("awaiting_user_after_bot");
      return;
    }
    if (topicClosed && gapH < 2) {
      reasons.push("topic_closed_hold");
      return;
    }

    if (trust.vulnerableReachOut) {
      plan.shouldInitiateConversation = true;
      plan.initiateReason = "vulnerable_reach_out";
      reasons.push("late_night_bond");
    }

    if (ctx.queuedMode) {
      plan.shouldInitiateConversation = true;
      plan.initiateReason = ctx.queuedMode;
      reasons.push("queued_initiative");
      return;
    }

    if (ctx.closeDecision === "silent" || ctx.closeDecision === "react") {
      if (gapMin > 90 && chance(seed, 0.08 + social * 0.12 + playful * 0.05)) {
        plan.shouldInitiateConversation = true;
        plan.initiateReason = "post_close_pull";
        reasons.push("post_close_initiative");
      }
      return;
    }

    if (ctx.initiationEval && gapMin >= 50 && gapMin < 180 && trailingBot === 0 && social > 0.55 && energy > 0.4) {
      if (chance(seed, 0.03 + social * 0.04)) {
        plan.shouldInitiateConversation = true;
        plan.initiateReason = "mid_lull_spark";
        reasons.push("mid_conversation_spark");
      }
    }

    if (gapH > 1.2 && gapH < 8 && trailingBot === 0 && social > 0.55 && chance(seed, 0.04 + social * 0.06)) {
      plan.shouldInitiateConversation = true;
      plan.initiateReason = subconscious ? "subconscious_thread" : "short_absence_pull";
      reasons.push("flexible_reconnect");
    }

    if (gapH >= 8 && social > 0.5 && chance(seed, 0.06 + social * 0.08)) {
      plan.shouldInitiateConversation = true;
      plan.initiateReason = subconscious ? "subconscious_pending" : "social_gap";
      reasons.push("initiate_conversation");
    }

    if ((trust.initiateBoost ?? 0) > 0.45 && gapMin > 120 && chance(seed, 0.08 + trust.initiateBoost * 0.12)) {
      plan.shouldInitiateConversation = true;
      plan.initiateReason = "bond_pull";
      reasons.push("trust_initiative");
    }
  }

  stageDelayComposer(plan, ctx, reasons) {
    const seed = contextualSeed(plan.reasons);
    const rand = seededRandom(seed);
    const jitter = Math.floor(rand() * 400);
    plan.readDelayMs = clamp(plan.readDelayMs + jitter, 0, 8000);
    plan.thinkDelayMs = clamp(plan.thinkDelayMs + jitter, 200, 15000);
    const typingBase = plan.typingProfile === "drowsy" ? 1200
      : plan.typingProfile === "energetic" ? 500
        : plan.typingProfile === "terse" ? 400
          : 800;
    plan.typingDelayMs = clamp(typingBase + Math.floor(rand() * 600), 140, 2400);
    reasons.push(`typing_${plan.typingProfile}`);
  }

  stageSilenceJudge(plan, ctx, reasons) {
    if (plan.silenceAppropriate) {
      reasons.push("silence_gate");
      return;
    }
    const seed = contextualSeed([ctx.message?.length, ctx.isGroup]);
    if (ctx.isGroup && !ctx.isMention && !ctx.isReply && chance(seed, 0.7)) {
      plan.silenceAppropriate = true;
      reasons.push("group_not_addressed");
    }
    if (ctx.repetition?.shouldStayQuiet) {
      plan.silenceAppropriate = true;
      reasons.push("repetition_awareness");
    }
  }

  tick(context = {}) {
    return this.computePlan(context);
  }
}

function sleepState(ctx) {
  return ctx.sleep?.state ?? ctx.life?.sleep?.state ?? "awake";
}
