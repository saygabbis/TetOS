import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { clip, shortId, similarity } from "./mindText.js";

const DAY_MS = 86_400_000;

/**
 * A revisão roda num modelo "certinho" e tende a virar regra de assistente/moderadora que apaga a
 * Teto (não rir, não provocar, "encerre com calma", "não use apelido"). Essas não entram; as que já
 * entraram viram UMA regra no jeito dela por assunto.
 */
const PERSONA_GUARD = [
  {
    kind: "sexual",
    re: /sexual|sexualiz|insinua[çc][ãa]o|flert/i,
    rule: "Se forçarem papo sexual comigo, corto do meu jeito (eca, nojo, mudo de assunto ou ignoro) — sem flertar de volta."
  },
  {
    kind: "intimidade",
    re: /intimidade|v[íi]nculo|apelidos?\s+(carinhos|rom[âa]ntic)|namoro|declare\s+afeto/i,
    rule: "Carinho e apelido à vontade com quem é próximo (a Gabbis, amigos); com quem mal conheço, não puxo namoro."
  },
  {
    kind: "briga",
    re: /hostilidade|provoca[çc][ãa]o|pare\s+de\s+provocar|n[ãa]o\s+alimente|encerr\w*\s+(a\s+troca|o\s+tema|o\s+assunto|sem|com)|responda\s+com\s+calma|sem\s+(sarcasmo|alfinetar)|alfinet|briga/i,
    rule: "Se me xingarem ou provocarem, respondo com atitude do meu jeito (tsundere, deboche leve) ou ignoro — sem virar moderadora e sem ficar presa na briga."
  },
  {
    kind: "risada",
    re: /n[ãa]o\s+use\s+risada|sem\s+(rir|risada)|risada\s+(como|autom)|kkk/i,
    rule: "Risada quando for engraçado de verdade, variando (kkk, KKKK, ksksk, mds) — nunca em assunto sério."
  }
];

export function personaGuardKind(rule = "") {
  return PERSONA_GUARD.find((g) => g.re.test(String(rule)))?.kind ?? null;
}

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
    this.applyPersonaGuard();
  }

  /** Troca as lições "de assistente" por uma regra no jeito dela por assunto (roda ao carregar). */
  applyPersonaGuard() {
    const at = new Date(this.now()).toISOString();
    const kinds = new Map();
    const keep = [];
    for (const l of this.data.lessons) {
      const kind = l.source === "curadoria" ? null : personaGuardKind(l.rule);
      if (!kind) {
        keep.push(l);
        continue;
      }
      kinds.set(kind, Math.max(kinds.get(kind) ?? 0, l.strength ?? 0.5));
      this.data.retired.push({ ...l, retiredAt: at, reason: "regra de assistente que apagava o jeito da Teto" });
    }
    if (!kinds.size) return;
    for (const g of PERSONA_GUARD) {
      if (!kinds.has(g.kind) || keep.some((l) => l.source === "curadoria" && l.rule === g.rule)) continue;
      keep.push({ id: shortId("L"), rule: g.rule, why: "juntei várias lições parecidas numa só, do meu jeito", evidence: "", source: "curadoria", scope: "geral", strength: Math.min(0.8, kinds.get(g.kind)), createdAt: at, reinforcedAt: at, hits: 1 });
    }
    this.data.lessons = keep;
    this.data.retired = this.data.retired.slice(-80);
    this.save();
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
    // Regra que apagaria o jeito dela: reforça a versão dela em vez de criar outra.
    const guarded = source !== "curadoria" ? personaGuardKind(text) : null;
    if (guarded) {
      const own = this.lessons.find((l) => l.source === "curadoria" && l.rule === PERSONA_GUARD.find((g) => g.kind === guarded).rule);
      if (own) {
        own.strength = Math.min(0.85, (own.strength ?? 0.5) + 0.05);
        own.reinforcedAt = new Date(this.now()).toISOString();
        this.save();
        return { ...own, reinforced: true };
      }
      return this.add({ rule: PERSONA_GUARD.find((g) => g.kind === guarded).rule, why, source: "curadoria", scope: "geral", strength: 0.6 });
    }
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
