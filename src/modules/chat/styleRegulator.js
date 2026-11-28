import { isLaughterOrNoiseToken } from "../../core/channels/profileFacts.js";
import { scanCommandArgs } from "./commandArgScanner.js";
import { hasLaughter, stripLaughter } from "../../core/mind/toneReader.js";

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

/**
 * Bolha comprida vira 2–3 bolhas curtas, do jeito do zap. O GPT tende a juntar tudo numa frase
 * longa cheia de vírgula (o Ollama já picava sozinho). Corta em fim de frase, depois em "mas"/"aí"/
 * "então", e só por último na vírgula do meio. Lista, link, código e quebra de linha ficam inteiros.
 */
const SPLIT_MIN_PIECE = 14;
export function splitLongBubble(text, maxPieces = 3) {
  const t = String(text ?? "").trim();
  if (maxPieces < 2 || t.length < 75) return [t];
  if (/\n|https?:\/\/|```|^\s*[-•\d]+[.)]?\s/m.test(t)) return [t];
  const cutAt = (str) => {
    const len = str.length;
    if (len < 75) return null;
    const best = (re, minLen = SPLIT_MIN_PIECE) => {
      let pick = null;
      for (const m of str.matchAll(re)) {
        const head = m.index + m[1].length;
        const left = str.slice(0, head).trim().replace(/[,;]$/, "");
        const right = str.slice(m.index + m[0].length).trim();
        if (left.length < minLen || right.length < minLen) continue;
        const score = Math.abs(head - len / 2);
        if (!pick || score < pick.score) pick = { left, right, score };
      }
      return pick;
    };
    return (
      best(/([.!?…]+|\p{Extended_Pictographic}+)\s+(?=\S)/gu) ||
      best(/(,?)\s+(?=(?:mas|só que|aí|ai|então|entao|tipo|porque|pq|e tipo|até porque)\s)/gi, 20) ||
      (len >= 110 ? best(/(,)\s+/g, 25) : null)
    );
  };
  const pieces = [t];
  while (pieces.length < maxPieces) {
    let idx = -1;
    let longest = 0;
    pieces.forEach((pc, i) => {
      if (pc.length > longest) {
        longest = pc.length;
        idx = i;
      }
    });
    const cut = idx >= 0 ? cutAt(pieces[idx]) : null;
    if (!cut) break;
    pieces.splice(idx, 1, cut.left, cut.right);
  }
  // zap não termina bolha com ponto final (reticências e ?! ficam)
  return pieces.map((pc) => pc.replace(/(?<![.])\.$/, "").trim()).filter(Boolean);
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

const THINK_COMMAND_RE = /\b(?:pensar|pensamento|think)\s*\(/gi;

/** Tira os `pensar("…")` (rascunho interno) da resposta crua — não vão pro histórico nem pro chat. */
export function stripThinkCommands(raw = "") {
  let text = String(raw ?? "").replace(/[“”„‟]/g, '"');
  for (let guard = 0; guard < 5; guard += 1) {
    THINK_COMMAND_RE.lastIndex = 0;
    const m = THINK_COMMAND_RE.exec(text);
    if (!m) break;
    const scanned = scanCommandArgs(text, m.index + m[0].length);
    const end = scanned?.end ?? text.indexOf(")", m.index);
    if (end < 0) break;
    let stop = end;
    while (stop < text.length && /[)\s]/.test(text[stop]) && text[stop] !== "\n") stop += 1;
    text = (text.slice(0, m.index) + text.slice(stop)).replace(/^\s*\n/, "");
  }
  return text.trim();
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

  // 1b) Bolha comprida → bolhas curtas (só até o limite de bolhas do canal).
  const capForSplit = Math.max(1, Math.min(isGroup ? GROUP_MAX_BUBBLES : DM_MAX_BUBBLES, maxParts || Infinity));
  if (structural && rows.length < capForSplit) {
    const next = [];
    let room = capForSplit - rows.length;
    for (const r of rows) {
      const pieces = room > 0 ? splitLongBubble(r.text, room + 1) : [r.text];
      room -= pieces.length - 1;
      pieces.forEach((text) => next.push({ text, from: r.from }));
    }
    rows = next;
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

  // 4) Risada: no máximo UMA por resposta (até 6 k), em qualquer canal. Bolha que era só risada some.
  let laughLeft = 1;
  for (const r of rows) {
    const before = r.text;
    r.text = stripLaughter(before, { keep: laughLeft, maxLen: 6 });
    if (hasLaughter(r.text)) laughLeft = 0;
  }
  if (structural) {
    const withText = rows.filter((r) => /[\p{L}\p{N}]/u.test(r.text));
    if (withText.length) rows = withText;
  }

  // 5) Anti-flood: poucas bolhas; o excesso vai junto na última (quebra de linha, como gente faz).
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
  const usedSources = new Set();
  const rebuilt = texts.map((text, i) => {
    const from = mergedFrom.get(i) ?? [];
    const sources = from.map((j) => original[j]);
    const base = sources[0] ?? original[0];
    // Bolha que nasceu da divisão de outra: só o primeiro pedaço cita.
    const continuation = from.length > 0 && from.every((j) => usedSources.has(j));
    from.forEach((j) => usedSources.add(j));
    const quoteId = continuation ? null : sources.find((s) => s?.quoteId)?.quoteId ?? base.quoteId ?? null;
    return { ...base, text, quoteId };
  });
  // As bolhas que sobraram ocupam os primeiros lugares de mensagem; os demais somem.
  const out = [];
  let slot = 0;
  let lastMsgPos = -1;
  for (const a of actions) {
    if (a?.type === "message" && String(a.text ?? "").trim()) {
      if (slot < rebuilt.length) {
        out.push(rebuilt[slot]);
        lastMsgPos = out.length - 1;
      }
      slot += 1;
    } else {
      out.push(a);
    }
  }
  // Bolhas a mais (da divisão de uma bolha comprida) entram logo depois da última mensagem.
  if (slot < rebuilt.length) out.splice(lastMsgPos + 1, 0, ...rebuilt.slice(slot));
  return out;
}

/**
 * Versão para o histórico: mesmas correções de texto (CAPS, pontuação, abertura repetida) direto na
 * resposta crua, para a IA não "aprender" consigo mesma os vícios que o filtro tirou do envio.
 */
export function tameRawReply(raw = "", { recentTurns = [], tone = null } = {}) {
  const text = String(raw ?? "");
  const originals = messageTextsFromRaw(text);
  if (!originals.length) return text;
  let { texts } = regulateBubbles(originals, { recentTurns, structural: false });
  // Tom do turno (ex.: assunto sério → sem risada): o histórico guarda o que de fato saiu.
  if (tone?.laugh === "none") texts = texts.map((t) => stripLaughter(t, { keep: 0 }));
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
