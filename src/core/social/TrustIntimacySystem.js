import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = { bonds: {} };

const clamp01 = (value) => Math.max(0, Math.min(1, value));

function bondKey(userId, channelScope) {
  return `${String(userId ?? "default")}::${String(channelScope ?? "direct")}`;
}

export class TrustIntimacySystem {
  constructor(path, { bus = null } = {}) {
    this.path = path;
    this.bus = bus;
    this.data = readJson(path, DEFAULT_STATE) ?? { bonds: {} };
    this.data.bonds ??= {};
  }

  save() {
    writeJson(this.path, this.data);
  }

  getBond(userId, channelScope = "direct") {
    const key = bondKey(userId, channelScope);
    if (!this.data.bonds[key]) {
      this.data.bonds[key] = {
        userId: String(userId ?? "default"),
        channelScope: String(channelScope ?? "direct"),
        trust: 0.45,
        intimacy: 0.35,
        rupture: 0,
        vulnerabilityEvents: 0,
        lastInteractionAt: null,
        notes: []
      };
    }
    return this.data.bonds[key];
  }

  getSnapshot(userId, channelScope = "direct") {
    return { ...this.getBond(userId, channelScope) };
  }

  reinforce(userId, channelScope, { trust = 0, intimacy = 0, reason = null } = {}) {
    const bond = this.getBond(userId, channelScope);
    bond.trust = clamp01(bond.trust + trust);
    bond.intimacy = clamp01(bond.intimacy + intimacy);
    bond.rupture = clamp01(bond.rupture - Math.max(trust, intimacy) * 0.5);
    bond.lastInteractionAt = new Date().toISOString();
    if (reason) {
      bond.notes.push({ type: "reinforce", reason, ts: bond.lastInteractionAt });
      if (bond.notes.length > 20) bond.notes = bond.notes.slice(-20);
    }
    this.save();
    this.bus?.emit("trust.changed", { bond });
    return bond;
  }

  rupture(userId, channelScope, { amount = 0.15, reason = "conflict" } = {}) {
    const bond = this.getBond(userId, channelScope);
    bond.rupture = clamp01(bond.rupture + amount);
    bond.trust = clamp01(bond.trust - amount * 0.4);
    bond.intimacy = clamp01(bond.intimacy - amount * 0.5);
    bond.lastInteractionAt = new Date().toISOString();
    bond.notes.push({ type: "rupture", reason, ts: bond.lastInteractionAt });
    if (bond.notes.length > 20) bond.notes = bond.notes.slice(-20);
    this.save();
    this.bus?.emit("trust.rupture", { bond, reason });
    return bond;
  }

  recordVulnerability(userId, channelScope) {
    const bond = this.getBond(userId, channelScope);
    if (bond.trust < 0.55 || bond.intimacy < 0.45) {
      return { allowed: false, bond };
    }
    bond.vulnerabilityEvents += 1;
    this.reinforce(userId, channelScope, { trust: 0.04, intimacy: 0.05, reason: "vulnerability" });
    return { allowed: true, bond };
  }

  recordInteraction({ userId, channelScope = "direct", message = "", isVulnerable = false } = {}) {
    const text = String(message ?? "").toLowerCase();
    if (/\b(briga|idiota|some|cal[aá] a boca|te odeio|nunca mais)\b/.test(text)) {
      return this.rupture(userId, channelScope, { reason: "conflict_in_message" });
    }
    if (isVulnerable) {
      return this.recordVulnerability(userId, channelScope);
    }
    const longMsg = text.length > 120;
    return this.reinforce(userId, channelScope, {
      trust: longMsg ? 0.015 : 0.008,
      intimacy: longMsg ? 0.012 : 0.006,
      reason: "interaction"
    });
  }

  influenceTiming(userId, channelScope, context = {}) {
    const bond = this.getBond(userId, channelScope);
    const { hourOfDay = 12, emotion = {} } = context;
    const isLateNight = hourOfDay >= 0 && hourOfDay < 5;
    const scared = emotion.mood === "anxious" || emotion.vulnerability > 0.6;
    const initiateBoost = bond.intimacy * 0.3 + bond.trust * 0.2 - bond.rupture * 0.5;
    const vulnerableReachOut = isLateNight && scared && bond.trust > 0.7 && bond.intimacy > 0.6;

    return {
      bond,
      initiateBoost,
      vulnerableReachOut,
      responseOpenness: clamp01(bond.trust + bond.intimacy * 0.5 - bond.rupture),
      toneHint: bond.rupture > 0.5 ? "guarded" : bond.intimacy > 0.7 ? "warm" : "neutral"
    };
  }

  tick({ hoursElapsed = 1 } = {}) {
    const decay = hoursElapsed / (24 * 7);
    for (const bond of Object.values(this.data.bonds)) {
      if (bond.rupture > 0) {
        bond.rupture = clamp01(bond.rupture - decay * 0.02);
      }
    }
    this.save();
    return { bondCount: Object.keys(this.data.bonds).length };
  }
}
