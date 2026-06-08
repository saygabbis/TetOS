import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { contextualSeed, chance } from "../brain/rng.js";

const DEFAULT_STATE = {
  active: [],
  history: [],
  regionalModifiers: {}
};

const CONDITION_CATALOG = {
  resfriado: { baseSeverity: 0.35, recoveryDays: 4, triggers: ["clima_frio", "exaustao"] },
  dor_cabeca: { baseSeverity: 0.25, recoveryDays: 1, triggers: ["stress", "cafeina", "sono_ruim"] },
  exaustao: { baseSeverity: 0.45, recoveryDays: 2, triggers: ["sono_ruim", "overwork"] },
  rouquidao: { baseSeverity: 0.3, recoveryDays: 3, triggers: ["ensaio", "show"] },
  jet_lag: { baseSeverity: 0.4, recoveryDays: 5, triggers: ["viagem_longa"] },
  alergia_sazonal: { baseSeverity: 0.2, recoveryDays: 7, triggers: ["polen", "clima"] },
  desanimo: { baseSeverity: 0.5, recoveryDays: 60, triggers: ["stress_cronico", "solidao"], chronic: true }
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

export class HealthConditions {
  constructor(path, { bus = null } = {}) {
    this.path = path;
    this.bus = bus;
    this.data = readJson(path, DEFAULT_STATE) ?? { ...DEFAULT_STATE };
    this.data.active ??= [];
    this.data.history ??= [];
  }

  save() {
    writeJson(this.path, this.data);
  }

  getActive() {
    return [...this.data.active];
  }

  onset(type, { reason = null, severity = null, region = null, triggers = [] } = {}) {
    const catalog = CONDITION_CATALOG[type];
    if (!catalog) return null;
    const existing = this.data.active.find((c) => c.type === type && c.status === "active");
    if (existing) {
      existing.severity = clamp01(existing.severity + 0.08);
      existing.lastFlareAt = new Date().toISOString();
      this.save();
      return existing;
    }
    const condition = {
      id: `${type}_${Date.now()}`,
      type,
      status: "active",
      onsetAt: new Date().toISOString(),
      severity: clamp01(severity ?? catalog.baseSeverity),
      reason: reason ?? "unspecified",
      region: region ?? null,
      triggers: triggers.length ? triggers : catalog.triggers,
      recoveryDays: catalog.recoveryDays,
      chronic: catalog.chronic ?? false,
      recoveryProgress: 0
    };
    this.data.active.push(condition);
    this.save();
    this.bus?.emit("health.flare", { condition });
    return condition;
  }

  tryRegionalTrigger(region, climateTags = [], context = {}) {
    const seed = contextualSeed([region, ...climateTags, context.hourOfDay]);
    const candidates = [];
    if (climateTags.includes("frio_seco") && chance(seed, 0.04)) candidates.push("resfriado");
    if (climateTags.includes("jet_lag") && chance(seed + 1, 0.25)) candidates.push("jet_lag");
    if (climateTags.includes("polen") && chance(seed + 2, 0.06)) candidates.push("alergia_sazonal");
    if (context.showTonight && chance(seed + 3, 0.15)) candidates.push("rouquidao");
    for (const type of candidates) {
      this.onset(type, { region, reason: `regional_${region}`, triggers: climateTags });
    }
    return candidates;
  }

  recover(conditionId, amount = 0.15) {
    const item = this.data.active.find((c) => c.id === conditionId);
    if (!item) return null;
    item.recoveryProgress = clamp01(item.recoveryProgress + amount);
    if (item.recoveryProgress >= 1) {
      item.status = "recovered";
      item.recoveredAt = new Date().toISOString();
      this.data.history.push(item);
      this.data.active = this.data.active.filter((c) => c.id !== conditionId);
    }
    this.save();
    return item;
  }

  tick({ hoursElapsed = 1, sleepQuality = 0.5, stress = 0.3, region = null } = {}) {
    const seed = contextualSeed([hoursElapsed, sleepQuality, stress]);
    for (const condition of [...this.data.active]) {
      const catalog = CONDITION_CATALOG[condition.type];
      const dailyRate = 1 / Math.max(1, catalog?.recoveryDays ?? 3);
      const recoveryBoost = sleepQuality > 0.6 ? dailyRate * hoursElapsed / 24 : dailyRate * hoursElapsed / 48;
      const stressPenalty = stress > 0.6 && condition.chronic ? -0.01 : 0;
      condition.recoveryProgress = clamp01(condition.recoveryProgress + recoveryBoost + stressPenalty);
      if (condition.recoveryProgress >= 1) {
        condition.status = "recovered";
        condition.recoveredAt = new Date().toISOString();
        this.data.history.push(condition);
        this.data.active = this.data.active.filter((c) => c.id !== condition.id);
      } else if (chance(seed + condition.type.length, 0.02 * stress)) {
        condition.severity = clamp01(condition.severity + 0.05);
        condition.lastFlareAt = new Date().toISOString();
        this.bus?.emit("health.flare", { condition });
      }
    }
    if (region) {
      this.data.regionalModifiers[region] = { updatedAt: new Date().toISOString() };
    }
    this.save();
    return {
      active: this.getActive(),
      severitySum: this.data.active.reduce((s, c) => s + c.severity, 0)
    };
  }
}
