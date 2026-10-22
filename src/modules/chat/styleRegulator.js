import { isLaughterOrNoiseToken } from "../../core/channels/profileFacts.js";
import { scanCommandArgs } from "./commandArgScanner.js";

/**
 * Último filtro de estilo antes do WhatsApp: segura os vícios que deixam a Teto com cara de bot
 * (CAPS a toda hora, "!!!!", a mesma interjeição abrindo toda resposta, 4 bolhas seguidas,
 * bolha repetida). Vale para qualquer origem — ações `mensagem()` ou lista simples de textos.
 */

const DM_MAX_BUBBLES = 3;
const GROUP_MAX_BUBBLES = 2;
const MAX_CAPS_RUN_WORDS = 2;

/** Interjeições que viram tique quando abrem toda resposta. */
const OPENERS = [
  "meu deus do céu", "meu deus", "minha nossa", "pelo amor de deus", "mentira", "mds", "mdss", "nossa",
  "gente", "socorro", "sério", "serio", "caraca", "caramba", "vish", "vixe", "eita", "oxi", "oxe",
  "aff", "afe", "ué", "ue", "uai", "aaah", "aah", "ahh", "ai ai", "aiai", "ai", "omg", "uau", "nossa senhora",
  "jura", "oloco", "olha só", "olha", "hmm", "hm", "ahn", "ok", "tá", "ta bom", "tá bom", "pronto"
].sort((a, b) => b.length - a.length);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OPENER_RE = new RegExp(`^(${OPENERS.map(escapeRe).join("|")})(?=$|[\\s,.!?…~:;])[\\s,.!?…~:;]*`, "iu");

const WORD_RE = /[\p{L}\p{N}]+/gu;

function stripAccents(s) {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

function normForCompare(text) {
  return stripAccents(String(text ?? "").toLowerCase())
    .replace(/(\p{L})\1{2,}/gu, "$1$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Siglas que existem em CAPS mesmo — não são grito. */
const ACRONYMS = new Set(["utau", "tv", "ok", "lol", "pc", "pv", "dm", "gif", "url", "api", "mv", "cd", "dvd", "br", "eua", "usa", "ia", "ai", "app", "rpg", "fps", "id", "dj", "kpop", "jpop", "bts", "ps5", "gta", "cpu", "gpu"]);

const letterCount = (word) => word.replace(/[^\p{L}]/gu, "").length;

/** Palavra toda em maiúsculas que não é risada, sigla nem código (ids de mensagem têm dígitos). */
function isUpperWord(word) {
  if (/\d/.test(word)) return false;
  const letters = word.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  if (letters !== letters.toLocaleUpperCase("pt-BR") || letters === letters.toLocaleLowerCase("pt-BR")) return false;
  return !isLaughterOrNoiseToken(word) && !ACRONYMS.has(word.toLowerCase());
}

/** Trechos em CAPS (palavras maiúsculas seguidas, com pelo menos uma de 3+ letras). */
function shoutRuns(text) {
  const runs = [];
  let current = null;
  const close = () => {
    if (current && current.longest >= 3) runs.push(current);
    current = null;
  };
  for (const m of String(text).matchAll(WORD_RE)) {
    const upper = isUpperWord(m[0]);
    const gapOk = current && /^[\s,.!?…~:;'"-]*$/u.test(text.slice(current.end, m.index));
    if (upper && current && gapOk) {
      current.end = m.index + m[0].length;
      current.words += 1;
      current.longest = Math.max(current.longest, letterCount(m[0]));
    } else if (upper) {
      close();
      current = { start: m.index, end: m.index + m[0].length, words: 1, longest: letterCount(m[0]) };
    } else if (current && !isLaughterOrNoiseToken(m[0])) {
      close();
    }
  }
  close();
  return runs;
}

function lowerRange(text, start, end) {
  return text.slice(0, start) + text.slice(start, end).toLocaleLowerCase("pt-BR") + text.slice(end);
}

export function hasShouting(text) {
  return shoutRuns(String(text ?? "")).length > 0;
}

/** "!!!!" → "!!", "????" → "??", "?!?!?!" → "?!". */
export function tamePunctuation(text) {
  return String(text ?? "")
    .replace(/!{3,}/g, "!!")
    .replace(/\?{3,}/g, "??")
    .replace(/([?!])([?!]){2,}/g, "$1$2");
}

/** Abertura (interjeição) da bolha, normalizada — ou null. */
export function extractOpener(text) {
  const m = String(text ?? "").trim().match(OPENER_RE);
  if (m) return stripAccents(m[1].toLowerCase()).replace(/(\p{L})\1+/gu, "$1");
  const first = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  if (first && isLaughterOrNoiseToken(first) && /k|rs|ha|he|ks/i.test(first)) return "<risada>";
  return null;
}

function stripOpener(text) {
  const t = String(text ?? "").trim();
  const m = t.match(OPENER_RE);
  if (m) return t.slice(m[0].length).trim();
  const [first, ...rest] = t.split(/\s+/);
  if (first && isLaughterOrNoiseToken(first)) return rest.join(" ").replace(/^[\s,.!?…~:;]+/u, "").trim();
  return t;
}

const MESSAGE_COMMAND_RE = /\b(?:mensagem|message|responder|reply|quote)\s*\(/gi;
const ANY_COMMAND_START_RE = /^[a-z]+\s*\(/i;

/** Textos dos `mensagem("…")` de uma resposta crua da IA. */
function messageTextsFromRaw(raw = "") {
  const text = String(raw ?? "").replace(/[\u201c\u201d\u201e\u201f]/g, '"');
  const out = [];
  for (const m of text.matchAll(MESSAGE_COMMAND_RE)) {
    const scanned = scanCommandArgs(text, m.index + m[0].length);
    if (scanned?.args?.[0]) out.push(scanned.args[0]);
  }
  return out;
}

/** Bolhas que a Teto mandou nos últimos turnos, do mais recente ao mais antigo. */
export function recentAssistantTurns(history = [], max = 4) {
  const turns = [];
  for (let i = history.length - 1; i >= 0 && turns.length < max; i -= 1) {
    const row = history[i];
    if (row?.role !== "assistant") continue;
    const raw = String(row.content ?? "");
    const parsed = messageTextsFromRaw(raw);
    const bubbles = parsed.length ? parsed : ANY_COMMAND_START_RE.test(raw.trim()) ? [] : raw.split(/\n-{3,}\n/);
    turns.push(bubbles.map((b) => b.trim()).filter(Boolean));
  }
  return turns;
}

/**
 * Ajusta as bolhas de uma resposta.
 * @param {string[]} texts
 * @param {{ isGroup?: boolean, recentTurns?: string[][], maxParts?: number, structural?: boolean }} ctx
 *   `structural: false` só mexe no texto de cada bolha (não junta, não remove) — usado no histórico.
 * @returns {{ texts: string[], mergedFrom: Map<number, number[]> }} `mergedFrom[i]` = índices originais que viraram a bolha i.
 */
export function regulateBubbles(texts = [], { isGroup = false, recentTurns = [], maxParts = Infinity, structural = true, dropIfAllRepeated = false } = {}) {
  let rows = texts
    .map((text, index) => ({ text: tamePunctuation(String(text ?? "").trim()), from: [index] }))
    .filter((r) => r.text);
  if (!rows.length) return { texts: [], mergedFrom: new Map() };

  // 1) Bolha repetida (na mesma resposta ou idêntica à que acabou de mandar).
  const lastTurn = new Set((recentTurns[0] ?? []).map(normForCompare));
  const seen = new Set();
  if (structural) {
    const kept = rows.filter((r) => {
      const key = normForCompare(r.text);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return !(rows.length > 1 && lastTurn.has(key) && key.split(" ").length >= 2);
    });
    // No grupo, repetir pra todo mundo o que acabou de dizer é pior que ficar quieta.
    const allRepeated = rows.every((r) => lastTurn.has(normForCompare(r.text)));
    if (dropIfAllRepeated && allRepeated && lastTurn.size) return { texts: [], mergedFrom: new Map() };
    // No PV, nunca zera a resposta: se tudo "repetiria", fica o que veio (melhor repetir que sumir).
    if (kept.length) rows = kept;
  }

  // 2) Mesma interjeição abrindo várias respostas seguidas vira tique: tira daqui.
  const recentOpeners = recentTurns.slice(0, 3).map((t) => extractOpener(t[0] ?? "")).filter(Boolean);
  const opener = extractOpener(rows[0].text);
  if (opener) {
    const repeats = recentOpeners.filter((o) => o === opener).length;
    const limit = opener === "<risada>" ? 2 : 1;
    if (repeats >= limit) {
      const rest = stripOpener(rows[0].text);
      if (rest && /[\p{L}\p{N}]/u.test(rest)) rows[0].text = rest;
      else if (structural && rows.length > 1) rows.shift();
    }
  }

  // 3) CAPS: no máximo um trecho curto por resposta, e nenhum se a anterior já gritou.
  const shoutedLastTurn = (recentTurns[0] ?? []).some(hasShouting);
  let capsBudget = shoutedLastTurn ? 0 : 1;
  for (const r of rows) {
    const runs = shoutRuns(r.text);
    for (let k = runs.length - 1; k >= 0; k -= 1) {
      const run = runs[k];
      const keep = capsBudget > 0 && run.words <= MAX_CAPS_RUN_WORDS && k === 0;
      if (!keep) r.text = lowerRange(r.text, run.start, run.end);
    }
    if (runs.length && capsBudget > 0 && runs[0].words <= MAX_CAPS_RUN_WORDS) capsBudget -= 1;
  }

  // 4) Anti-flood: poucas bolhas; o excesso vai junto na última (quebra de linha, como gente faz).
  const cap = Math.max(1, Math.min(isGroup ? GROUP_MAX_BUBBLES : DM_MAX_BUBBLES, maxParts || Infinity));
  if (structural && rows.length > cap) {
    const head = rows.slice(0, cap - 1);
    const tail = rows.slice(cap - 1);
    head.push({ text: tail.map((r) => r.text).join("\n"), from: tail.flatMap((r) => r.from) });
    rows = head;
  }

  const mergedFrom = new Map(rows.map((r, i) => [i, r.from]));
  return { texts: rows.map((r) => r.text), mergedFrom };
}

/**
 * Mesma regulação aplicada a uma lista de ações: só as `message` mudam; as outras (reação,
 * figurinha, mídia…) ficam onde estavam. A bolha resultante herda o quote da primeira que absorveu.
 */
export function regulateMessageActions(actions = [], ctx = {}) {
  const messageIdx = [];
  actions.forEach((a, i) => {
    if (a?.type === "message" && String(a.text ?? "").trim()) messageIdx.push(i);
  });
  if (!messageIdx.length) return actions;
  const original = messageIdx.map((i) => actions[i]);
  const { texts, mergedFrom } = regulateBubbles(original.map((a) => a.text), ctx);
  const rebuilt = texts.map((text, i) => {
    const sources = (mergedFrom.get(i) ?? []).map((j) => original[j]);
    const base = sources[0] ?? original[0];
    const quoteId = sources.find((s) => s?.quoteId)?.quoteId ?? base.quoteId ?? null;
    return { ...base, text, quoteId };
  });
  // As bolhas que sobraram ocupam os primeiros lugares de mensagem; os demais somem.
  const out = [];
  let slot = 0;
  for (const a of actions) {
    if (a?.type === "message" && String(a.text ?? "").trim()) {
      if (slot < rebuilt.length) out.push(rebuilt[slot]);
      slot += 1;
    } else {
      out.push(a);
    }
  }
  return out;
}

/**
 * Versão para o histórico: mesmas correções de texto (CAPS, pontuação, abertura repetida) direto na
 * resposta crua, para a IA não "aprender" consigo mesma os vícios que o filtro tirou do envio.
 */
export function tameRawReply(raw = "", { recentTurns = [] } = {}) {
  const text = String(raw ?? "");
  const originals = messageTextsFromRaw(text);
  if (!originals.length) return text;
  const { texts } = regulateBubbles(originals, { recentTurns, structural: false });
  let out = text.replace(/[\u201c\u201d\u201e\u201f]/g, '"');
  let from = 0;
  originals.forEach((orig, i) => {
    const next = texts[i];
    if (next == null || next === orig) return;
    const at = out.indexOf(orig, from);
    if (at < 0) return;
    out = out.slice(0, at) + next + out.slice(at + orig.length);
    from = at + next.length;
  });
  return out;
}
