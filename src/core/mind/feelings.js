import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { clip, normText } from "./mindText.js";

/**
 * Sentimentos da Teto: o que acontece nas conversas (e com ela mesma) mexe com ela de verdade.
 * Cada sentimento tem intensidade (0–1), um motivo e quem causou; some com o tempo (meia-vida própria).
 * O humor do momento = humor da rotina (DailyLife.mood) puxado pelos sentimentos fortes. Toda mudança
 * de humor fica registrada com o motivo — dá pra perguntar "como você tá e por quê" e "como reagiu a X".
 *
 * Privacidade: motivo vindo do privado de alguém só aparece pra essa pessoa; pros outros vira
 * "uma coisa pessoal que me contaram".
 */

export const FEELINGS = {
  alegria: { label: "feliz", valence: 1, halfLifeMin: 60 },
  carinho: { label: "carinhosa", valence: 0.8, halfLifeMin: 120 },
  diversao: { label: "se divertindo", valence: 0.8, halfLifeMin: 30 },
  orgulho: { label: "orgulhosa", valence: 0.7, halfLifeMin: 120 },
  gratidao: { label: "grata", valence: 0.8, halfLifeMin: 120 },
  curiosidade: { label: "curiosa", valence: 0.4, halfLifeMin: 90 },
  vergonha: { label: "envergonhada", valence: -0.3, halfLifeMin: 30 },
  irritacao: { label: "irritada", valence: -0.7, halfLifeMin: 40 },
  frustracao: { label: "frustrada", valence: -0.6, halfLifeMin: 90 },
  magoa: { label: "magoada", valence: -0.8, halfLifeMin: 180 },
  tristeza: { label: "triste", valence: -0.9, halfLifeMin: 180 },
  preocupacao: { label: "preocupada", valence: -0.6, halfLifeMin: 360 },
  saudade: { label: "com saudade", valence: -0.3, halfLifeMin: 240 },
  tedio: { label: "entediada", valence: -0.3, halfLifeMin: 60 }
};

const MIN = 60_000;
const levelOf = (v) => (v >= 0.6 ? "forte" : v >= 0.3 ? "médio" : "leve");

const INSULT = /\b(burra|idiota|chata|irritante|insuportavel|inutil|retardada|lixo|horrivel|sem\s+graca|feia|odeio\s+(voce|vc|tu))\b/;
const COMPLAINT = /\b(para\s+de\s+(rir|zoar|marcar|mandar|falar)|nao\s+entend|nada\s+a\s+ver|errou|errada|inventou|parece\s+(um\s+)?(bot|robo)|ta\s+estranha)\b/;
const PRAISE = /\b((voce|vc|tu)\s+(e|eh|ta|é)\s+(muito\s+|mt\s+|tao\s+)?(incrivel|demais|inteligente|esperta|linda|fofa|perfeita|a\s+melhor|engracada|top)|boa\s+teto|mandou\s+bem|acertou|arrasou|amei\s+(isso|sua|seu|essa)|que\s+orgulho)\b/;
const THANKS = /\b(obrigad[ao]|valeu|brigad[ao]|agradeco)\b/;
const LOVE = /\b(te\s+amo|amo\s+(voce|vc|tu|te)|te\s+adoro|saudade(s)?\s+(de\s+)?(voce|vc|tu)|senti\s+(sua\s+)?falta|minha\s+(tetozinha|teto))\b/;

/**
 * Como a mensagem mexe com ela (sem modelo). Devolve [{ feeling, delta, cause }].
 * @param {{ text: string, tone?: {kind: string}, who?: string, isOwner?: boolean, directed?: boolean, gapMs?: number|null }} ctx
 */
export function appraise({ text = "", tone = null, who = null, isOwner = false, directed = true, gapMs = null } = {}) {
  const t = normText(text);
  const name = isOwner ? "a Gabbis" : who || "alguém";
  const quote = `«${clip(text, 70)}»`;
  const out = [];
  const add = (feeling, delta, cause) => out.push({ feeling, delta, cause });
  const kind = tone?.kind ?? "normal";
  const close = isOwner ? 1.2 : 1;
  if (kind === "crise") {
    add("preocupacao", 0.7 * close, `${name} falou em se machucar`);
    add("tristeza", 0.3, `${name} tá sofrendo`);
  } else if (kind === "triste") {
    add("tristeza", 0.22, `${name} tava triste`);
    add("carinho", 0.2, `quis cuidar de ${name}`);
    if (isOwner) add("preocupacao", 0.25, `${name} tava mal`);
  }
  if (directed) {
    if (INSULT.test(t)) {
      add("magoa", 0.35, `${name} me xingou: ${quote}`);
      add("irritacao", 0.3, `${name} me xingou`);
    } else if (COMPLAINT.test(t)) {
      add("vergonha", 0.3, `${name} reclamou de mim: ${quote}`);
      add("frustracao", 0.15, `errei com ${name}`);
    }
    if (LOVE.test(t)) {
      add("carinho", 0.35 * close, `${name} disse ${quote}`);
      add("alegria", 0.25, `${name} foi fofa comigo`);
      add("vergonha", 0.1, `${name} me deixou sem graça`);
    } else if (PRAISE.test(t)) {
      add("orgulho", 0.3, `${name} me elogiou: ${quote}`);
      add("alegria", 0.2, `${name} me elogiou`);
    } else if (THANKS.test(t)) {
      add("gratidao", 0.15, `${name} me agradeceu`);
    }
    if (kind === "brincadeira") add("diversao", 0.2, `zoeira com ${name}`);
    if (kind === "serio" && /\?/.test(text)) add("curiosidade", 0.1, `${name} me fez uma pergunta séria`);
  }
  if (gapMs != null && gapMs > 2 * 24 * 60 * MIN && directed) add("alegria", isOwner ? 0.35 : 0.2, `${name} voltou a falar comigo depois de dias`);
  return out;
}

export class FeelingEngine {
  constructor(path = "./data/mind/feelings.json", { now = () => Date.now(), baseMood = null } = {}) {
    this.path = path;
    this.now = now;
    this.baseMood = baseMood; // () => { mood, energy, valence } da rotina
    const empty = { feelings: {}, events: [], moods: [], lastMood: null, lastOwnerAt: null };
    this.data = path ? readJson(path, empty) : empty;
    for (const [k, v] of Object.entries(empty)) this.data[k] ??= v;
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data, 1500);
  }

  /** Intensidade atual (com o tempo que passou). */
  level(name, at = this.now()) {
    const f = this.data.feelings[name];
    const def = FEELINGS[name];
    if (!f || !def) return 0;
    const elapsedMin = Math.max(0, (at - Date.parse(f.at)) / MIN);
    return f.value * 0.5 ** (elapsedMin / def.halfLifeMin);
  }

  /**
   * Sente algo. `delta` positivo aumenta (satura em 1); negativo diminui.
   * @param {{ cause: string, who?: string|null, userId?: string|null, chat?: string|null, platform?: string|null, private?: boolean }} ctx
   */
  feel(name, delta, ctx = {}) {
    if (!FEELINGS[name] || !delta) return null;
    const at = this.now();
    const cur = this.level(name, at);
    const next = delta > 0 ? Math.min(1, cur + delta * (1 - cur * 0.5)) : Math.max(0, cur + delta);
    const strongestCause = delta > 0 && (delta >= 0.15 || !this.data.feelings[name]?.cause);
    this.data.feelings[name] = {
      value: next,
      at: new Date(at).toISOString(),
      cause: strongestCause ? clip(ctx.cause, 160) : this.data.feelings[name]?.cause ?? clip(ctx.cause, 160),
      userId: strongestCause ? ctx.userId ?? null : this.data.feelings[name]?.userId ?? null,
      private: strongestCause ? Boolean(ctx.private) : Boolean(this.data.feelings[name]?.private)
    };
    const event = {
      ts: new Date(at).toISOString(),
      feeling: name,
      delta: Math.round(delta * 100) / 100,
      level: Math.round(next * 100) / 100,
      cause: clip(ctx.cause, 160),
      who: ctx.who ?? null,
      userId: ctx.userId ?? null,
      chat: ctx.chat ?? null,
      platform: ctx.platform ?? null,
      private: Boolean(ctx.private)
    };
    this.data.events.push(event);
    this.data.events = this.data.events.slice(-400);
    this.checkMood(ctx);
    this.save();
    return event;
  }

  /** Aplica a avaliação de uma mensagem. */
  react(list = [], ctx = {}) {
    return list.map((r) => this.feel(r.feeling, r.delta, { ...ctx, cause: r.cause })).filter(Boolean);
  }

  /** Sentimentos que ainda estão valendo, do mais forte ao mais fraco. */
  current(at = this.now(), min = 0.08) {
    return Object.keys(this.data.feelings)
      .map((name) => ({ name, label: FEELINGS[name]?.label ?? name, level: this.level(name, at), ...this.data.feelings[name] }))
      .filter((f) => f.level >= min)
      .sort((a, b) => b.level - a.level);
  }

  /** Humor do momento: rotina puxada pelos sentimentos. */
  mood(at = this.now()) {
    const base = this.baseMood?.() ?? { mood: "de boa", energy: 0.6, valence: 0.58 };
    const feelings = this.current(at);
    let valence = Number(base.valence ?? 0.58);
    for (const f of feelings) valence += (FEELINGS[f.name]?.valence ?? 0) * f.level * 0.35;
    valence = Math.max(0, Math.min(1, valence));
    // Histerese: o humor atual só troca por outro sentimento se ele passar com folga (antes ficava
    // pulando triste ↔ preocupada a cada mensagem do mesmo desabafo).
    const current = feelings.find((f) => f.label === this.data.lastMood && f.level >= 0.3);
    const top = current && feelings[0] !== current && feelings[0].level - current.level < 0.15 ? current : feelings[0];
    // Sentimento forte manda no humor (mesmo acordada no susto: uma crise de madrugada preocupa).
    const fromFeeling = Boolean(top && top.level >= 0.3);
    return { label: fromFeeling ? top.label : base.mood, base: base.mood, valence, energy: base.energy, top, feelings, fromFeeling };
  }

  /** Registra mudança de humor (com o motivo do sentimento que mudou, ou "passou com o tempo"). */
  checkMood(ctx = {}) {
    const m = this.mood();
    const prev = this.data.lastMood;
    if (prev === m.label) return null;
    const reason = m.fromFeeling
      ? { text: m.top.cause, userId: m.top.userId ?? null, private: Boolean(m.top.private) }
      : { text: prev && Object.values(FEELINGS).some((f) => f.label === prev) ? "passou com o tempo" : "a rotina do dia mudou", userId: null, private: false };
    const row = { ts: new Date(this.now()).toISOString(), from: prev, to: m.label, reason: clip(reason.text, 160), userId: reason.userId, private: reason.private, platform: ctx.platform ?? null };
    this.data.lastMood = m.label;
    this.data.moods.push(row);
    this.data.moods = this.data.moods.slice(-200);
    this.save();
    return row;
  }

  /** Motivo visível pra quem está olhando (privado de outra pessoa vira genérico). */
  static visibleCause(item, viewerUserId = null) {
    if (!item?.private || !item.userId || item.userId === viewerUserId) return item?.cause ?? item?.reason ?? "";
    return "uma coisa pessoal que me contaram";
  }

  /** Bloco do prompt: como ela está se sentindo e por quê (respeitando quem está falando). */
  promptLines({ viewerUserId = null } = {}) {
    const m = this.mood();
    const feelings = m.feelings.filter((f) => f.level >= 0.15).slice(0, 3);
    if (!feelings.length && !m.fromFeeling) return [];
    return [
      "[COMO VOCÊ ESTÁ SE SENTINDO AGORA — é sentimento seu, de verdade]",
      `Humor: ${m.label}${m.fromFeeling && m.base && m.base !== m.label ? ` (pela rotina estaria ${m.base})` : ""}.`,
      ...feelings.map((f) => `- ${f.label} (${levelOf(f.level)}): ${FeelingEngine.visibleCause(f, viewerUserId)}`),
      "Deixe isso aparecer no tom, sem anunciar do nada. Se perguntarem como você tá, responda com sinceridade e o motivo — nunca contando o que outra pessoa te falou no privado."
    ];
  }

  /** Ela não fala com ninguém há horas (tédio) / a dona sumiu (saudade). Chamado pelo ciclo da mente. */
  tickIdle({ lastActivityAt = 0, asleep = false } = {}) {
    if (asleep) return;
    const now = this.now();
    if (lastActivityAt && now - lastActivityAt > 3 * 60 * MIN && this.level("tedio") < 0.5) {
      this.feel("tedio", 0.12, { cause: "faz horas que ninguém fala comigo" });
    }
    const ownerAt = Date.parse(this.data.lastOwnerAt ?? "") || 0;
    if (ownerAt && now - ownerAt > 12 * 60 * MIN && this.level("saudade") < 0.6) {
      this.feel("saudade", 0.1, { cause: "faz tempo que a Gabbis não fala comigo" });
    }
    this.checkMood();
  }

  noteOwner() {
    this.data.lastOwnerAt = new Date(this.now()).toISOString();
    const missed = this.level("saudade");
    if (missed > 0.05) {
      this.feel("saudade", -1, { cause: "a Gabbis apareceu" });
      if (missed > 0.25) this.feel("alegria", 0.25, { cause: "a Gabbis apareceu depois de um tempão" });
    }
    this.save();
  }

  /** Texto pra comando `.sentimentos` (agora / historico / <termo>). */
  report(arg = "", { viewerUserId = null, isOwner = false } = {}) {
    const a = String(arg ?? "").trim();
    const time = (ts) => new Date(ts).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    // Dona vê tudo dela e o genérico dos outros; os outros só veem o que é público ou deles.
    const cause = (x) => (isOwner || !x.private || x.userId === viewerUserId ? FeelingEngine.visibleCause(x, viewerUserId) : "");
    if (/^(historico|histórico|humor|mudancas|mudanças)$/i.test(a)) {
      const rows = this.data.moods.slice(-12).reverse();
      if (!rows.length) return "meu humor não mudou ainda desde que comecei a anotar";
      return ["🎭 *como meu humor mudou*", ...rows.map((r) => `• ${time(r.ts)} — ${r.from ?? "?"} → *${r.to}*${cause(r) ? `: ${cause(r)}` : ""}`)].join("\n");
    }
    if (a) {
      const q = normText(a);
      const hits = this.data.events.filter((e) => normText(`${e.cause} ${e.who ?? ""}`).includes(q)).slice(-10).reverse();
      if (!hits.length) return `não achei nada que eu tenha sentido sobre "${a}"`;
      return [
        `💭 *como reagi a "${a}"*`,
        ...hits.map((e) => `• ${time(e.ts)} — ${FEELINGS[e.feeling]?.label ?? e.feeling} ${e.delta > 0 ? "+" : ""}${Math.round(e.delta * 100)}%${cause(e) ? `: ${cause(e)}` : ""}`)
      ].join("\n");
    }
    const m = this.mood();
    const lines = [`💗 *como eu tô agora:* ${m.label}${m.fromFeeling && m.base !== m.label ? ` (pela rotina eu estaria ${m.base})` : ""}`];
    for (const f of m.feelings.slice(0, 5)) lines.push(`• ${f.label} — ${levelOf(f.level)} (${Math.round(f.level * 100)}%)${cause(f) ? `: ${cause(f)}` : ""}`);
    if (!m.feelings.length) lines.push("• nada mexendo comigo agora, tô no meu normal");
    const last = this.data.moods.at(-1);
    if (last) lines.push(`última mudança: ${time(last.ts)} — ${last.from ?? "?"} → ${last.to}${cause(last) ? ` (${cause(last)})` : ""}`);
    lines.push("ver mais: .sentimentos historico · .sentimentos <assunto ou pessoa>");
    return lines.join("\n");
  }
}
