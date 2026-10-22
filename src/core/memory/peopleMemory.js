import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";

/**
 * Memória "de gente" da Teto: um caderno por pessoa (PV) e por grupo, reescrito pelo modelo auxiliar
 * quando a conversa esfria — como quem repassa o dia de cabeça. Guarda o que importa (fatos, planos
 * com data, aniversários, como a pessoa anda) e esquece o miúdo com o tempo.
 *
 * Escopo é sagrado: o caderno do PV só aparece no PV daquela pessoa; o do grupo só naquele grupo.
 */

const IDLE_BEFORE_CONSOLIDATE_MS = 12 * 60_000;
const FORCE_CONSOLIDATE_LINES = 40;
const MIN_LINES = 4;
const MAX_BUFFER_LINES = 80;
const MAX_FACTS = 30;
const PROMPT_FACTS = 8;
const DAY = 24 * 60 * 60 * 1000;
/** Quanto tempo um fato vive sem ser lembrado de novo, por importância (1–5). */
const FACT_TTL_DAYS = { 1: 21, 2: 45, 3: 120, 4: 365, 5: 3650 };
const KINDS = new Set(["gosto", "rotina", "trabalho", "estudo", "saude", "relacao", "familia", "plano", "outro"]);

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = (s) => clip(s, 300).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N} ]/gu, "").trim();

function notebookKey(userId, scope = "direct") {
  return `${String(userId ?? "default")}|${scope || "direct"}`;
}

/** Primeiro objeto JSON do texto do modelo (ele às vezes embrulha em ```json ou comenta antes). */
export function parseModelJson(text = "") {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function emptyNotebook(userId, scope, name) {
  return { userId, scope, name: name ?? null, summary: "", mood: "", facts: [], threads: [], dates: [], updatedAt: null, lastTalkAt: null };
}

/** Aplica a resposta do modelo ao caderno (pura — testável sem LLM). */
export function applyConsolidation(notebook, update, { now = Date.now() } = {}) {
  const nb = structuredClone(notebook);
  if (!update || typeof update !== "object") return nb;
  const iso = new Date(now).toISOString();
  if (update.resumo) nb.summary = clip(update.resumo, 400);
  if (update.humor) nb.mood = clip(update.humor, 120);

  const wrong = new Set((update.fatos_errados ?? []).map(norm));
  nb.facts = nb.facts.filter((f) => !wrong.has(norm(f.t)));
  for (const f of update.fatos_novos ?? []) {
    const t = clip(typeof f === "string" ? f : f?.texto, 160);
    if (!t) continue;
    const imp = Math.min(5, Math.max(1, Math.round(Number(f?.importancia) || 2)));
    const k = KINDS.has(f?.tipo) ? f.tipo : "outro";
    const same = nb.facts.find((x) => norm(x.t) === norm(t));
    if (same) {
      same.seen = iso;
      same.imp = Math.max(same.imp, imp);
    } else {
      nb.facts.push({ t, k, imp, at: iso, seen: iso });
    }
  }

  const resolved = new Set((update.pendencias_resolvidas ?? []).map(norm));
  for (const th of nb.threads) if (resolved.has(norm(th.t))) th.done = iso;
  for (const p of update.pendencias ?? []) {
    const t = clip(typeof p === "string" ? p : p?.texto, 140);
    if (!t || nb.threads.some((x) => norm(x.t) === norm(t))) continue;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(p?.quando ?? "")) ? p.quando : null;
    nb.threads.push({ t, due, at: iso, done: null });
  }

  for (const d of update.datas ?? []) {
    const md = String(d?.dia ?? "");
    const t = clip(d?.texto, 60);
    if (!/^\d{2}-\d{2}$/.test(md) || !t) continue;
    if (!nb.dates.some((x) => x.md === md && norm(x.t) === norm(t))) nb.dates.push({ t, md });
  }

  nb.updatedAt = iso;
  return forget(nb, { now });
}

/** Esquece o que perdeu a importância: fato miúdo antigo, pendência resolvida ou vencida há tempo. */
export function forget(notebook, { now = Date.now() } = {}) {
  const nb = notebook;
  nb.facts = nb.facts
    .filter((f) => now - Date.parse(f.seen ?? f.at ?? 0) < (FACT_TTL_DAYS[f.imp] ?? 45) * DAY)
    .sort((a, b) => b.imp - a.imp || Date.parse(b.seen) - Date.parse(a.seen))
    .slice(0, MAX_FACTS);
  nb.threads = nb.threads.filter((th) => {
    if (th.done) return now - Date.parse(th.done) < 3 * DAY;
    if (th.due) return now - Date.parse(`${th.due}T23:59:00`) < 10 * DAY;
    return now - Date.parse(th.at) < 30 * DAY;
  });
  nb.dates = nb.dates.slice(-12);
  return nb;
}

const fmtDay = (ymd) => ymd.split("-").reverse().slice(0, 2).join("/");

function buildConsolidationPrompt(nb, lines, { isGroup, today }) {
  const who = isGroup ? `o grupo "${nb.name ?? "do zap"}"` : nb.name ?? "essa pessoa";
  const current = {
    resumo: nb.summary || null,
    fatos: nb.facts.map((f) => f.t),
    pendencias: nb.threads.filter((t) => !t.done).map((t) => (t.due ? `${t.t} (${t.due})` : t.t)),
    datas: nb.dates.map((d) => `${d.t} ${d.md}`)
  };
  const convo = lines.map((l) => `${l.r === "teto" ? "Teto" : l.n || "Pessoa"}: ${clip(l.t, 400)}`).join("\n");
  return [
    `Você é a memória da Kasane Teto, uma garota que conversa no WhatsApp. Atualize o caderno dela sobre ${who} com base na conversa nova.`,
    `Hoje é ${today}.`,
    `Caderno atual: ${JSON.stringify(current)}`,
    "Conversa nova (da mais antiga para a mais nova):",
    convo,
    "",
    "Responda SÓ com um JSON neste formato:",
    '{"resumo":"2 frases: como a pessoa (ou o grupo) anda e como está a relação com a Teto","humor":"como estava","fatos_novos":[{"texto":"fato curto em 3ª pessoa","tipo":"gosto|rotina|trabalho|estudo|saude|relacao|familia|plano|outro","importancia":1}],"fatos_errados":["fato do caderno que ficou errado"],"pendencias":[{"texto":"coisa que vai acontecer e vale perguntar depois","quando":"AAAA-MM-DD ou null"}],"pendencias_resolvidas":["pendência do caderno que já aconteceu"],"datas":[{"texto":"aniversário","dia":"MM-DD"}]}',
    "Regras: só registre o que foi DITO (nada inventado); importância 1 = detalhe bobo, 5 = coisa que uma amiga nunca esqueceria; ignore conversa fiada e piada passageira; nada sobre a própria Teto; datas relativas (amanhã, sexta) viram AAAA-MM-DD.",
    isGroup ? "É um grupo: escreva os fatos com o nome de quem disse (ex.: 'Bia ama gatos'). Não registre segredos." : ""
  ].filter(Boolean).join("\n");
}

export class PeopleMemory {
  constructor(path, { llm = null, now = () => Date.now(), timeZone = "America/Sao_Paulo" } = {}) {
    this.path = path;
    this.llm = llm;
    this.now = now;
    this.timeZone = timeZone;
    this.data = readJson(path, { notebooks: {}, buffers: {} });
    this.data.notebooks ??= {};
    this.data.buffers ??= {};
    this.running = false;
  }

  save() {
    writeJsonDeferred(this.path, this.data);
  }

  notebook(userId, scope = "direct") {
    return this.data.notebooks[notebookKey(userId, scope)] ?? null;
  }

  /** Anota uma fala para a próxima consolidação. Grupo: userId = id do grupo (caderno do grupo). */
  record({ userId, scope = "direct", name = null, speaker = null, role = "user", text = "" } = {}) {
    const t = clip(text, 600);
    if (!userId || !t || /^\[(sticker|figurinha|audio|media)\]$/i.test(t)) return;
    const key = notebookKey(userId, scope);
    const buf = (this.data.buffers[key] ??= { userId, scope, name, lines: [], lastAt: 0 });
    if (name) buf.name = name;
    buf.lines.push({ r: role === "assistant" || role === "teto" ? "teto" : "user", n: speaker ?? name ?? null, t, at: this.now() });
    if (buf.lines.length > MAX_BUFFER_LINES) buf.lines.splice(0, buf.lines.length - MAX_BUFFER_LINES);
    buf.lastAt = this.now();
    const nb = (this.data.notebooks[key] ??= emptyNotebook(userId, scope, name));
    if (name && !nb.name) nb.name = name;
    nb.lastTalkAt = new Date(this.now()).toISOString();
    this.save();
  }

  dueKeys() {
    const now = this.now();
    return Object.entries(this.data.buffers)
      .filter(([, b]) => {
        const userLines = b.lines.filter((l) => l.r === "user").length;
        if (userLines < 2 || b.lines.length < MIN_LINES) return false;
        return now - b.lastAt >= IDLE_BEFORE_CONSOLIDATE_MS || b.lines.length >= FORCE_CONSOLIDATE_LINES;
      })
      .sort((a, b) => a[1].lastAt - b[1].lastAt)
      .map(([k]) => k);
  }

  async consolidateDue({ max = 2 } = {}) {
    if (this.running || !this.llm?.generate) return 0;
    this.running = true;
    let done = 0;
    try {
      for (const key of this.dueKeys().slice(0, max)) {
        if (await this.consolidate(key)) done += 1;
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  async consolidate(key) {
    const buf = this.data.buffers[key];
    if (!buf?.lines?.length) return false;
    const lines = buf.lines.slice();
    const nb = this.data.notebooks[key] ?? emptyNotebook(buf.userId, buf.scope, buf.name);
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: this.timeZone }).format(new Date(this.now()));
    const prompt = buildConsolidationPrompt(nb, lines, { isGroup: String(buf.scope).startsWith("group:"), today });
    let update = null;
    try {
      update = parseModelJson(await this.llm.generate(prompt));
    } catch (error) {
      console.warn(`[memória] consolidação falhou (${key}): ${error?.message ?? error}`);
      return false;
    }
    if (!update) return false;
    this.data.notebooks[key] = applyConsolidation(nb, update, { now: this.now() });
    // Só tira do buffer o que foi consolidado (pode ter chegado fala nova durante a chamada).
    buf.lines.splice(0, lines.length);
    if (!buf.lines.length) delete this.data.buffers[key];
    this.save();
    return true;
  }

  /** Linhas do prompt: o que ela sabe dessa pessoa (ou desse grupo), pendências e datas de hoje. */
  promptLines(userId, scope = "direct", { name = null, isGroup = false } = {}) {
    const nb = this.notebook(userId, scope);
    if (!nb || (!nb.summary && !nb.facts.length && !nb.threads.length)) return [];
    const now = this.now();
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: this.timeZone }).format(new Date(now));
    const md = today.slice(5);
    const label = isGroup ? "deste grupo" : `de ${name ?? nb.name ?? "quem está falando"}`;
    const lines = [`[MEMÓRIA — o que você lembra ${label}]`];
    if (nb.summary) lines.push(nb.summary);
    for (const f of nb.facts.slice(0, PROMPT_FACTS)) lines.push(`- ${f.t}`);
    const open = nb.threads.filter((t) => !t.done);
    const dueSoon = open.filter((t) => !t.due || Math.abs(Date.parse(`${t.due}T12:00:00`) - now) <= 3 * DAY);
    for (const t of dueSoon.slice(0, 3)) {
      const when = t.due ? (t.due === today ? " (é hoje)" : t.due < today ? ` (era ${fmtDay(t.due)})` : ` (${fmtDay(t.due)})`) : "";
      lines.push(`- pendente: ${t.t}${when}`);
    }
    for (const d of nb.dates.filter((x) => x.md === md)) lines.push(`- HOJE: ${d.t}!`);
    lines.push(
      "Use como quem lembra de verdade: só quando encaixar no papo, sem listar nem anunciar 'eu lembro que'. Pendência vencida = pode perguntar como foi, uma vez."
    );
    return lines;
  }

  /** Pendências vencidas/de hoje e datas especiais — combustível para ela puxar assunto. */
  followUps(userId, scope = "direct") {
    const nb = this.notebook(userId, scope);
    if (!nb) return [];
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: this.timeZone }).format(new Date(this.now()));
    const out = nb.threads.filter((t) => !t.done && t.due && t.due <= today).map((t) => `perguntar como foi: ${t.t}`);
    for (const d of nb.dates.filter((x) => x.md === today.slice(5))) out.push(`hoje é ${d.t} — dar parabéns/carinho`);
    return out;
  }

  /** Marca que ela já puxou o assunto (para não perguntar a mesma coisa de novo). */
  markFollowedUp(userId, scope, text) {
    const nb = this.notebook(userId, scope);
    if (!nb) return;
    for (const t of nb.threads) if (!t.done && String(text).includes(t.t)) t.done = new Date(this.now()).toISOString();
    this.save();
  }
}
