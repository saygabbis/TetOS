import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { hasLaughter } from "./toneReader.js";
import { askModel, clip, parseJsonLoose } from "./mindText.js";

/**
 * Autorrevisão: a Teto relê as próprias conversas, mede os vícios (risada, figurinha, tamanho,
 * pergunta no fim, reclamação de quem falou com ela) e escreve lições pra si mesma; também decide o
 * que quer estudar e que habilidade criar. Os números saem do código; o julgamento, do modelo.
 */

const COMPLAINT_RE = /(para\s+de\s+(rir|zoar|marcar|mandar)|n[aã]o\s+entend|nada\s+a\s+ver|que\s+isso\s*\?|h[ãa]\s*\?|\bbot\b|\brob[oô]\b|\bia\b.*(burra|ruim)|sem\s+graça|chata|n[aã]o\s+foi\s+isso|errou|errada|mentira\s+sua|inventou)/i;

/** Últimas trocas (entrada → respostas → reação seguinte), pra revisão. */
export class TurnLog {
  constructor(path = "./data/mind/turns.json", { max = 300, now = () => Date.now() } = {}) {
    this.path = path;
    this.max = max;
    this.now = now;
    this.data = path ? readJson(path, { turns: [] }) : { turns: [] };
    this.data.turns ??= [];
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data, 2000);
  }

  get turns() {
    return this.data.turns;
  }

  /** Reação que chegou depois da última resposta neste chat (até 15 min). */
  noteIncoming(chat, text) {
    const last = [...this.turns].reverse().find((t) => t.chat === chat);
    if (!last || last.reaction || this.now() - Date.parse(last.ts) > 15 * 60_000) return;
    last.reaction = clip(text, 200);
    this.save();
  }

  record({ chat, platform = "whatsapp", isGroup = false, who = null, input = "", replies = [], stickers = 0, tone = null } = {}) {
    if (!replies.length && !stickers) return;
    this.turns.push({
      ts: new Date(this.now()).toISOString(),
      chat,
      platform,
      isGroup,
      who: who ? clip(who, 40) : null,
      input: clip(input, 300),
      replies: replies.map((r) => clip(r, 300)).slice(0, 3),
      stickers,
      tone: tone?.kind ?? null,
      reaction: null
    });
    if (this.turns.length > this.max) this.data.turns = this.turns.slice(-this.max);
    this.save();
  }

  since(ts) {
    return this.turns.filter((t) => Date.parse(t.ts) > ts);
  }
}

/** Números das conversas (sem modelo). */
export function measureTurns(turns = []) {
  const n = turns.length;
  if (!n) return { n: 0 };
  const laughed = turns.filter((t) => t.replies.some(hasLaughter));
  const serious = turns.filter((t) => ["crise", "triste", "irritado", "serio"].includes(t.tone));
  const seriousLaughed = serious.filter((t) => t.replies.some(hasLaughter));
  const chars = turns.map((t) => t.replies.join(" ").length);
  const complaints = turns.filter((t) => t.reaction && COMPLAINT_RE.test(t.reaction));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  return {
    n,
    laughPct: pct(laughed.length, n),
    seriousLaughPct: pct(seriousLaughed.length, serious.length),
    seriousN: serious.length,
    stickerPct: pct(turns.filter((t) => t.stickers > 0).length, n),
    avgChars: Math.round(chars.reduce((a, b) => a + b, 0) / n),
    questionEndPct: pct(turns.filter((t) => /\?\s*$/.test(t.replies.at(-1) ?? "")).length, n),
    multiBubblePct: pct(turns.filter((t) => t.replies.length > 1).length, n),
    complaintPct: pct(complaints.length, n),
    complaints: complaints.slice(-6).map((t) => ({ input: t.input, replies: t.replies, reaction: t.reaction }))
  };
}

/** Amostra pra revisão: tudo que teve reclamação + o resto espalhado (até `max`). */
export function sampleTurns(turns = [], max = 28) {
  const flagged = turns.filter((t) => t.reaction && COMPLAINT_RE.test(t.reaction));
  const serious = turns.filter((t) => ["crise", "triste", "irritado", "serio"].includes(t.tone) && !flagged.includes(t));
  const rest = turns.filter((t) => !flagged.includes(t) && !serious.includes(t));
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, max - flagged.length - Math.min(serious.length, 6))));
  const spread = rest.filter((_, i) => i % step === 0);
  return [...flagged.slice(-8), ...serious.slice(-6), ...spread].slice(0, max);
}

export function buildReflectionPrompt({ metrics, sample = [], lessons = [], errors = [], knowledgeTopics = [], persona = "" }) {
  const turnsText = sample
    .map((t, i) => {
      const where = `${t.platform}${t.isGroup ? " grupo" : " pv"}${t.tone ? `, tom ${t.tone}` : ""}`;
      return `#${i + 1} (${where}) ${t.who ?? "pessoa"}: «${t.input}»\n   você: ${t.replies.map((r) => `«${r}»`).join(" ")}${t.stickers ? ` [+figurinha]` : ""}${t.reaction ? `\n   reação depois: «${t.reaction}»` : ""}`;
    })
    .join("\n");
  return [
    "Você é a Kasane Teto revisando as SUAS próprias conversas recentes, sozinha, pra melhorar de verdade.",
    persona ? `Quem você é: ${persona}` : "",
    "",
    "[NÚMEROS — medidos pelo sistema]",
    `trocas: ${metrics.n} | com risada: ${metrics.laughPct}% | risada em assunto sério: ${metrics.seriousLaughPct}% (de ${metrics.seriousN}) | com figurinha: ${metrics.stickerPct}% | tamanho médio: ${metrics.avgChars} letras | terminando em pergunta: ${metrics.questionEndPct}% | várias bolhas: ${metrics.multiBubblePct}% | reação de reclamação: ${metrics.complaintPct}%`,
    "Referência de gente real no zap: risada em ~20–30% das mensagens, nunca em assunto sério; figurinha de vez em quando; pergunta no fim em menos de 30%.",
    "Regras que já valem e que suas lições NÃO podem contradizer: respostas curtas (1 bolha na maioria), nem toda resposta termina em pergunta, não esticar o papo, risada só quando engraçado, nada de @ à toa, acolher assunto sério.",
    "",
    "[SUAS LIÇÕES ATUAIS]",
    lessons.length ? lessons.map((l) => `${l.id}: ${l.rule}`).join("\n") : "(nenhuma)",
    "",
    errors.length ? `[ERROS DO SEU SISTEMA nas últimas horas]\n${errors.map((e) => `- ${e.count}x ${e.message}`).join("\n")}\n` : "",
    knowledgeTopics.length ? `[TEMAS QUE VOCÊ JÁ ESTUDOU]\n${knowledgeTopics.join("; ")}\n` : "",
    "[CONVERSAS]",
    turnsText || "(sem conversas)",
    "",
    "Analise com honestidade: onde você foi chata, sem noção, repetitiva, riu fora de hora, não entendeu o tom, inventou coisa, ficou presa numa briga, não soube algo?",
    "Responda SÓ com JSON neste formato (sem texto fora):",
    '{"defeitos":[{"defeito":"...","evidencia":"#3 ...","licao":"regra curta no imperativo pra você mesma (sem nomes de pessoas)","escopo":"geral|grupo|pv|whatsapp|discord"}],',
    ' "aposentar":[{"id":"L...","motivo":"..."}],',
    ' "estudar":[{"tema":"assunto genérico pra pesquisar (sem nomes nem coisas privadas)","porque":"..."}],',
    ' "habilidade":{"nome":"...","para_que":"..."} ou null,',
    ' "melhorar_codigo":{"objetivo":"melhoria concreta no seu código/sistema","detalhe":"o que muda e por quê"} ou null,',
    ' "pedir_dona":{"o_que":"algo que só a Gabbis pode fazer (chave de API, conta, instalar algo, configuração)","porque":"..."} ou null,',
    ' "humor":"uma frase sua sobre como você se sente com isso"}',
    "Regras: no máximo 4 defeitos (só os reais, com evidência), no máximo 3 temas, no máximo 1 habilidade, 1 melhoria de código e 1 pedido. Lição é comportamento concreto (ex.: 'Em desabafo, não ria nem mande figurinha'), não frase vaga ('seja melhor'). Nunca coloque dado pessoal de ninguém.",
    "Melhoria de código: só se você viu um defeito que é do sistema (erro, algo que você não consegue fazer, lentidão), não de jeito de falar (isso é lição). Se mexer em parte protegida, você vai pedir autorização pra Gabbis."
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Roda a revisão no modelo e devolve o resultado já limpo (ou null). */
export async function reflect(llm, input, { timeoutMs = 120_000 } = {}) {
  const raw = await askModel(llm, buildReflectionPrompt(input), { timeoutMs });
  const json = parseJsonLoose(raw);
  if (!json || typeof json !== "object") return null;
  const defects = (Array.isArray(json.defeitos) ? json.defeitos : [])
    .filter((d) => d && typeof d.licao === "string" && d.licao.trim().length >= 8)
    .slice(0, 4)
    .map((d) => ({ defect: clip(d.defeito, 200), evidence: clip(d.evidencia, 240), rule: clip(d.licao, 200), scope: String(d.escopo ?? "geral") }));
  const retire = (Array.isArray(json.aposentar) ? json.aposentar : []).filter((r) => r?.id).slice(0, 4);
  const study = (Array.isArray(json.estudar) ? json.estudar : [])
    .filter((s) => s && typeof s.tema === "string" && s.tema.trim().length >= 3)
    .slice(0, 3)
    .map((s) => ({ topic: clip(s.tema, 120), why: clip(s.porque, 200) }));
  const skill = json.habilidade && typeof json.habilidade === "object" && json.habilidade.nome
    ? { name: clip(json.habilidade.nome, 60), purpose: clip(json.habilidade.para_que, 300) }
    : null;
  const improve = json.melhorar_codigo && typeof json.melhorar_codigo === "object" && json.melhorar_codigo.objetivo
    ? { goal: clip(json.melhorar_codigo.objetivo, 160), detail: clip(json.melhorar_codigo.detalhe, 500) }
    : null;
  const ask = json.pedir_dona && typeof json.pedir_dona === "object" && json.pedir_dona.o_que
    ? { what: clip(json.pedir_dona.o_que, 160), why: clip(json.pedir_dona.porque, 300) }
    : null;
  return { defects, retire, study, skill, improve, ask, mood: clip(json.humor, 200) };
}
