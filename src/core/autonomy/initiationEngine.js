import { contextualSeed, chance, seededRandom } from "../brain/rng.js";
import { classifyAbsence } from "./absenceClassifier.js";
import {
  analyzeGhosting,
  initiativeDeferMultiplier,
  lastUserTurn,
  shouldAllowInitiation
} from "./ghostingPolicy.js";

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function resolveDmSessionId(userId, profile = null) {
  if (profile?.facts?.lastDmSessionId) return profile.facts.lastDmSessionId;
  const uid = String(userId ?? "").trim();
  if (uid.startsWith("dm-")) return `wa-dm:${uid.slice(3)}@lid`;
  if (/@/.test(uid)) return `wa-dm:${uid}`;
  return `wa-dm:${uid}@s.whatsapp.net`;
}

function summarizeThread(history = [], max = 6) {
  const rows = Array.isArray(history) ? history.slice(-max) : [];
  return rows
    .map((m) => {
      const q = m.meta?.quotedMessage ? ` [↩ ${String(m.meta.quotedMessage).slice(0, 60)}]` : "";
      return `${m.role}${q}: ${String(m.content ?? "").slice(0, 140)}`;
    })
    .join("\n");
}

function openThreadHint(history = []) {
  const rows = Array.isArray(history) ? history : [];
  const lastAssistant = [...rows].reverse().find((m) => m?.role === "assistant");
  const lastUser = [...rows].reverse().find((m) => m?.role === "user");
  if (lastAssistant?.content) {
    return String(lastAssistant.content).slice(0, 220);
  }
  if (lastUser?.content) {
    return String(lastUser.content).slice(0, 220);
  }
  return "";
}

function computeDeferMs({ mode, social = 0.5, gapMs = 0, seed = 0, ghosting = null }) {
  const rand = seededRandom(seed);
  const r = () => rand();
  const ghostMult = initiativeDeferMultiplier(ghosting ?? {}, mode);

  if (mode === "thread_continue" || mode === "natural_lull") {
    const base = 2_700_000 + r() * 3_600_000;
    const socialBoost = (1 - social) * 1_800_000;
    return clamp(Math.floor((base + socialBoost) * ghostMult), 2_400_000, 7_200_000);
  }
  if (mode === "post_close") {
    return clamp(
      Math.floor((3_600_000 + r() * 7_200_000 + (1 - social) * 2_400_000) * ghostMult),
      3_600_000,
      14_400_000
    );
  }
  if (mode === "solo_thought") {
    return clamp(Math.floor((7_200_000 + r() * 10_800_000) * ghostMult), 5_400_000, 28_800_000);
  }
  if (mode === "ghost_check") {
    return clamp(Math.floor((4_500_000 + r() * 5_400_000) * ghostMult), 3_600_000, 14_400_000);
  }

  const gapH = gapMs > 0 ? gapMs / 3_600_000 : 8;
  const scaled = gapH * 900_000 * (0.5 + r() * 0.9);
  return clamp(Math.floor(scaled * ghostMult), 1_800_000, 172_800_000);
}

export function coerceImpulse(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => coerceImpulse(v)).filter(Boolean).join(" ").trim();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.content === "string") return value.content.trim();
    if (typeof value.detail === "string") return value.detail.trim();
  }
  return String(value).trim();
}

function impulseFromArbitration(winner, snapshot = {}) {
  if (!winner) return "";
  const detail = coerceImpulse(winner.detail);
  switch (winner.source) {
    case "autonomous":
      return coerceImpulse(snapshot.autonomous?.soloThoughts?.at(-1)?.text) || detail;
    case "music":
      return coerceImpulse(snapshot.music?.pendingComment) || detail;
    case "social":
      return detail;
    case "trust":
      return "vontade de chegar perto sem pressionar";
    case "world":
      return detail;
    case "life":
      return `ainda tô em ${detail} mas lembrei dessa pessoa`;
    default:
      return detail;
  }
}

export class InitiationEngine {
  constructor({
    brainOrchestrator = null,
    timeStore = null,
    userPatterns = null,
    internalState = null,
    shortTerm = null,
    longTerm = null,
    initiationQueue = null
  } = {}) {
    this.brainOrchestrator = brainOrchestrator;
    this.timeStore = timeStore;
    this.userPatterns = userPatterns;
    this.internalState = internalState;
    this.shortTerm = shortTerm;
    this.longTerm = longTerm;
    this.queue = initiationQueue;
  }

  buildBrainTurn(userId, sessionId, extra = {}) {
    if (!this.brainOrchestrator) return null;
    const hour = new Date().getHours();
    const emotion = this.brainOrchestrator.emotion?.getSnapshot?.() ?? {};
    const lastMessageAt = this.timeStore?.getLastUserMessage?.(userId, sessionId) ?? null;
    const trustBond = this.brainOrchestrator.enrichTrustForTiming?.(userId, "direct", emotion, hour) ?? null;
    const subconscious = this.brainOrchestrator.narrator?.buildSubconscious?.({
      emotion,
      life: this.brainOrchestrator.life?.getSnapshot?.() ?? {},
      social: this.brainOrchestrator.social?.getSnapshot?.() ?? {},
      trustBond,
      repetition: this.brainOrchestrator.repetition?.getSnapshot?.(sessionId)
    });

    const timingCtx = {
      userId,
      sessionId,
      channelScope: "direct",
      hourOfDay: hour,
      emotion,
      lastMessageAt,
      lastUserMessageAt: lastMessageAt,
      userLikelyActive: this.userPatterns?.isLikelyActiveNow?.(userId) ?? true,
      trustBond,
      life: this.brainOrchestrator.life?.getSnapshot?.() ?? {},
      sleep: this.brainOrchestrator.life?.sleep?.getSnapshot?.() ?? {},
      subconscious,
      initiationEval: true,
      ...extra
    };

    const timingPlan = this.brainOrchestrator.timing?.computePlan?.(timingCtx) ?? null;
    const snapshot = this.brainOrchestrator.buildSnapshot?.({
      userId,
      sessionId,
      emotion,
      trustBond,
      timing: timingPlan
    }) ?? { emotion, timing: timingPlan };

    const arbitration = this.brainOrchestrator.arbitrator?.run?.(snapshot, timingCtx) ?? null;
    const blocks = this.brainOrchestrator.narrator?.buildBlocks?.({
      emotion,
      life: snapshot.life ?? this.brainOrchestrator.life?.getSnapshot?.() ?? {},
      trustBond,
      timing: timingPlan,
      arbitration
    }) ?? {};

    return { snapshot, timingPlan, arbitration, blocks, trustBond, emotion };
  }

  scheduleFromTurn({
    userId,
    sessionId,
    mode = "post_close",
    closeDecision = null,
    history = [],
    brainTurn = null
  } = {}) {
    if (!this.queue || !userId) return null;
    if (closeDecision && closeDecision !== "silent" && closeDecision !== "react") return null;

    const brain = brainTurn ?? this.buildBrainTurn(userId, sessionId, { closeDecision });
    const social = brain?.emotion?.social ?? this.internalState?.getState?.()?.social ?? 0.55;
    const seed = contextualSeed([userId, mode, social, history.length]);
    if (!chance(seed, 0.1 + social * 0.18)) return null;

    const gapMs = this.gapMs(userId, sessionId);
    const lastUser = lastUserTurn(history);
    const ghosting = analyzeGhosting({
      history,
      gapSinceUserMs: gapMs,
      lastUserText: lastUser?.content ?? ""
    });
    const gate = shouldAllowInitiation(ghosting, { mode });
    if (!gate.allow) return null;

    const impulse =
      impulseFromArbitration(brain?.arbitration?.winner, brain?.snapshot) ||
      openThreadHint(history) ||
      "algo ficou no ar e bateu vontade de falar";

    const deferMs = computeDeferMs({ mode, social, gapMs, seed, ghosting });

    return this.queue.schedule({
      userId,
      sessionId,
      mode,
      impulse,
      deferMs,
      brainSeed: { mode, social, gapMs },
      meta: { closeDecision, threadHint: openThreadHint(history).slice(0, 200) }
    });
  }

  gapMs(userId, sessionId) {
    if (this.timeStore?.gapSinceUserMs) {
      return this.timeStore.gapSinceUserMs(userId, sessionId);
    }
    const last = this.timeStore?.getLastUserMessage?.(userId, sessionId);
    if (!last) return 0;
    const t = Date.parse(last);
    return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0;
  }

  evaluateForUser(userId = "default", now = Date.now()) {
    const profile = this.longTerm?.getProfile?.(userId) ?? {};
    const sessionId = resolveDmSessionId(userId, profile);
    const history = this.shortTerm?.getAll?.(sessionId)?.slice(-14) ?? [];
    const gapMs = this.gapMs(userId, sessionId);
    const lastUser = lastUserTurn(history);
    const ghosting = analyzeGhosting({
      history,
      gapSinceUserMs: gapMs,
      lastUserText: lastUser?.content ?? ""
    });
    const absence = classifyAbsence(
      this.timeStore?.getLastUserMessage?.(userId, sessionId),
      now
    );

    const queued = this.queue?.pendingForUser?.(userId);
    const dueQueued = this.queue?.dueEntries?.(now)?.find((e) => e.userId === userId);

    const brain = this.buildBrainTurn(userId, sessionId, {
      queuedMode: dueQueued?.mode ?? queued?.mode ?? null,
      ghosting,
      trailingBotTurns: ghosting.trailingBot,
      topicClosed: ghosting.topicClosed,
      gapSinceUserMs: gapMs
    });

    const social = brain?.emotion?.social ?? this.internalState?.getState?.()?.social ?? 0.55;
    const intimacy = brain?.trustBond?.intimacy ?? 0.4;
    const seed = contextualSeed([userId, gapMs, social, intimacy, absence.label]);

    let mode = null;
    let impulse = "";
    let shouldInitiate = false;

    const gate = shouldAllowInitiation(ghosting, { mode: dueQueued?.mode ?? null });

    if (dueQueued) {
      if (gate.allow) {
        shouldInitiate = true;
        mode = dueQueued.mode;
        impulse = coerceImpulse(dueQueued.impulse) || openThreadHint(history);
      }
    } else if (brain?.timingPlan?.shouldInitiateConversation && gate.allow) {
      const ghostPenalty =
        ghosting.level === "soft" ? 0.35 : ghosting.topicClosed ? 0.45 : 0;
      shouldInitiate = chance(seed, 0.28 + social * 0.18 - ghostPenalty);
      mode = brain.timingPlan.initiateReason ?? "social_pull";
      impulse =
        impulseFromArbitration(brain.arbitration?.winner, brain.snapshot) ||
        coerceImpulse(brain.blocks?.conscious) ||
        coerceImpulse(brain.blocks?.subconscious) ||
        coerceImpulse(brain.timingPlan.distanceContext) ||
        "";
    } else if (absence.label !== "short" && social > 0.42 && gate.allow) {
      const p = absence.label === "medium" ? 0.08 : 0.14;
      if (chance(seed, p + intimacy * 0.12)) {
        shouldInitiate = true;
        mode = absence.label === "very_long" ? "reconnect_far" : "reconnect";
        impulse = coerceImpulse(brain.blocks?.conscious) || coerceImpulse(brain.blocks?.subconscious) || "";
      }
    } else if (
      ghosting.level === "soft" &&
      gate.allow &&
      ghosting.gapSinceUserMs > 3 * 3600_000 &&
      chance(seed, 0.12 + intimacy * 0.1)
    ) {
      shouldInitiate = true;
      mode = "ghost_check";
      impulse = "checar se a pessoa sumiu de boa ou tá ocupada — sem cobrar";
    } else if (queued && !dueQueued) {
      return null;
    } else if (brain?.arbitration?.winner?.source === "autonomous" && social > 0.5 && gate.allow) {
      if (chance(seed, 0.05 + social * 0.08)) {
        shouldInitiate = true;
        mode = "solo_thought";
        impulse = coerceImpulse(brain.snapshot?.autonomous?.soloThoughts?.at(-1)?.text);
      }
    }

    impulse = coerceImpulse(impulse);
    if (!shouldInitiate || !impulse) return null;

    const suggestedCooldownMs = computeDeferMs({
      mode: mode ?? "reconnect",
      social,
      gapMs,
      seed: seed + 1,
      ghosting
    });

    return {
      shouldInitiate: true,
      userId,
      sessionId,
      mode,
      impulse,
      ghosting,
      topicClosed: ghosting.topicClosed,
      threadSummary: summarizeThread(history),
      threadHint: openThreadHint(history),
      absence: absence.label,
      gapMs,
      timingPlan: brain?.timingPlan ?? null,
      brainBlocks: brain?.blocks ?? null,
      brainSnapshot: brain?.snapshot ?? null,
      arbitration: brain?.arbitration ?? null,
      suggestedCooldownMs,
      tone: social > 0.6 ? "playful" : "calm",
      queueEntryId: dueQueued?.id ?? null
    };
  }

  markSent(entryId) {
    this.queue?.markSent?.(entryId);
  }

  cancelForUser(userId) {
    this.queue?.cancelForUser?.(userId);
  }
}
