import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { clip, shortId, similarity } from "./mindText.js";

const DAY_MS = 86_400_000;

/**
 * Lições de comportamento que a própria Teto escreveu ao revisar as conversas dela (ou que decidiu
 * adotar depois de um pedido). Entram no prompt como regras dela mesma. Lição reforçada fica mais
 * forte; lição esquecida enfraquece com o tempo e se aposenta sozinha.
 */
export class LessonBook {
  constructor(path = "./data/mind/lessons.json", { max = 40, now = () => Date.now() } = {}) {
    this.path = path;
    this.max = max;
    this.now = now;
    this.data = path ? readJson(path, { lessons: [], retired: [] }) : { lessons: [], retired: [] };
    this.data.lessons ??= [];
    this.data.retired ??= [];
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  get lessons() {
    return this.data.lessons;
  }

  /**
   * Nova lição (ou reforço de uma parecida).
   * @param {{ rule: string, why?: string, evidence?: string, source?: string, scope?: "geral"|"whatsapp"|"discord"|"grupo"|"pv", strength?: number }} input
   */
  add({ rule, why = "", evidence = "", source = "reflexao", scope = "geral", strength = 0.6 } = {}) {
    const text = clip(rule, 200);
    if (!text || text.length < 8) return null;
    const at = new Date(this.now()).toISOString();
    const same = this.lessons.find((l) => similarity(l.rule, text) >= 0.55);
    if (same) {
      same.strength = Math.min(1, (same.strength ?? 0.5) + 0.15);
      same.reinforcedAt = at;
      same.hits = (same.hits ?? 1) + 1;
      if (why) same.why = clip(why, 200);
      this.save();
      return { ...same, reinforced: true };
    }
    const lesson = {
      id: shortId("L"),
      rule: text,
      why: clip(why, 200),
      evidence: clip(evidence, 240),
      source,
      scope: ["geral", "whatsapp", "discord", "grupo", "pv"].includes(scope) ? scope : "geral",
      strength: Math.max(0.2, Math.min(1, strength)),
      createdAt: at,
      reinforcedAt: at,
      hits: 1
    };
    this.lessons.push(lesson);
    if (this.lessons.length > this.max) {
      this.lessons.sort((a, b) => b.strength - a.strength);
      for (const l of this.lessons.splice(this.max)) this.data.retired.push({ ...l, retiredAt: at, reason: "sem espaço" });
    }
    this.save();
    return lesson;
  }

  retire(id, reason = "") {
    const i = this.lessons.findIndex((l) => l.id === id);
    if (i < 0) return null;
    const [l] = this.lessons.splice(i, 1);
    this.data.retired.push({ ...l, retiredAt: new Date(this.now()).toISOString(), reason: clip(reason, 160) });
    this.data.retired = this.data.retired.slice(-80);
    this.save();
    return l;
  }

  /** Enfraquece o que não é reforçado há dias; aposenta abaixo de 0,2. */
  decay() {
    const now = this.now();
    for (const l of [...this.lessons]) {
      const days = (now - Date.parse(l.reinforcedAt ?? l.createdAt)) / DAY_MS;
      if (days < 3) continue;
      l.strength = Math.max(0, (l.strength ?? 0.5) - 0.02 * Math.floor(days - 2));
      l.reinforcedAt = new Date(now - 2 * DAY_MS).toISOString();
      if (l.strength < 0.2) this.retire(l.id, "não precisou mais");
    }
    this.save();
  }

  active({ platform = null, isGroup = false, limit = 6 } = {}) {
    const fits = (l) =>
      l.scope === "geral" ||
      (l.scope === "grupo" && isGroup) ||
      (l.scope === "pv" && !isGroup) ||
      (platform && l.scope === platform);
    return this.lessons.filter(fits).sort((a, b) => b.strength - a.strength).slice(0, limit);
  }

  promptLines(ctx = {}) {
    const list = this.active(ctx);
    if (!list.length) return [];
    return [
      "[SUAS LIÇÕES — você mesma revisou suas conversas e decidiu mudar isso]",
      ...list.map((l) => `- ${l.rule}`),
      "São regras SUAS: siga sem comentar que tem regras."
    ];
  }
}
