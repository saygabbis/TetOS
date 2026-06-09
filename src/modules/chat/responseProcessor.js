import { isMessyLaughterMessage } from "../../core/memory/extractor.js";
import {
  collapseForShortUserPrompt,
  isIncompleteBubble,
  normalizeInformalEnding,
  repairBubbleCoherence
} from "./coherenceGuards.js";
import { planBubbleRhythm } from "./bubbleComposer.js";

const ROLEPLAY_MARKERS = /\*[^*]{1,20}\*/g;
const IDENTITY_LOOPS = /\b(eu sou (a )?kasane teto|eu sou a própria kasane teto|sou kasane teto)\b/gi;
const META_TALK = /\b(você disse|você perguntou|você falou|sua mensagem|você (tá|ta|está|esta) (perguntando|achando|dizendo))\b/gi;
const REMINDER_TALK = /\b(lembra\??!?)\b/gi;
const TITLE_TALK = /\b(princesa|rainha)\b/gi;
const AI_DISCLAIMER = /\b(as an ai|as a language model)\b/gi;
const ENGLISH_FILLERS = /\b(by the way|btw|anyway|anyways|i mean|you know|well(?:\s+then)?|cool|nice|yep|yeah|nope|pls|please|thanks|thank you|pleasant|sorry|lol|im|i'm|ive|i've|id|i'd|dont|don't|cant|can't|wont|won't|youre|you're|your|yours)\b/gi;
const ENGLISH_TOKENS = /\b(working|work|distract|weekend|sorry|thanks|thank|pleasant|your|yours|youre|you're|dont|don't|cant|can't|wont|won't|im|i'm|ive|i've)\b/gi;
const PROPER_NOUNS = new Set(["teto", "kasane", "miku", "gabbis", "whatsapp", "brasil", "são", "paulo", "tokyo", "japão", "japao"]);
const MID_SENTENCE_CAPITAL = new Set([
  "então",
  "entao",
  "mas",
  "só",
  "so",
  "aí",
  "ai",
  "bora",
  "porém",
  "porem",
  "também",
  "tambem",
  "daí",
  "dai",
  "oxi",
  "mds",
  "aff",
  "ué",
  "ue",
  "nossa",
  "poxa",
  "ora",
  "tipo",
  "enfim"
]);
const MASC_A_WORDS = new Set([
  "dia",
  "mapa",
  "programa",
  "tema",
  "sistema",
  "problema",
  "clima",
  "drama",
  "idioma",
  "poema"
]);

function normalizeLaughter(text) {
  // Não achatar kkk longos — só corta sequências absurdas (spam acidental).
  return text.replace(/k{45,}/gi, (m) => `${m.slice(0, 32)}`);
}

function preferredKkSample(styleHint = {}) {
  const run = Number(styleHint?.userKkMaxRun ?? styleHint?.learned?.avgKkRun ?? 0);
  if (run >= 12) return "kkkkkkk";
  if (run >= 8) return "kkkkkk";
  if (run >= 5) return "kkkkk";
  return "kkk";
}

/** Risada brasileira no teclado > emoji de riso no WhatsApp. */
function swapEmojiLaughterForKkk(text, styleHint = {}, tone = null) {
  if (!/[\u{1F602}\u{1F923}\u{1F605}\u{1F60A}]/u.test(String(text ?? ""))) {
    return text;
  }
  let sample = preferredKkSample(styleHint);
  if (tone === "calm" || styleHint?.userLaughterEnergy === "low") {
    sample = "kkk";
  }
  return String(text)
    .replace(/[😂🤣😹😆😅]+/gu, ` ${sample}`)
    .replace(/\s{2,}/g, " ")
    .trim();
}

function endsWithKeyboardLaugh(text = "") {
  return /\s(?:k{2,}|ksks|rs+)\s*$/i.test(String(text ?? "").trim());
}

/** Evita kkk em toda bolha seguida quando o usuário não riu — mantém no máximo uma. */
function trimRedundantKkk(parts, context = {}) {
  const list = (Array.isArray(parts) ? parts : []).map((p) => String(p ?? "").trim()).filter(Boolean);
  if (list.length <= 1) return list;

  const userLaughs =
    /\b(k{2,}|ksks|rs+)\b/i.test(String(context.userMessage ?? "")) ||
    isMessyLaughterMessage(context.userMessage);
  if (userLaughs || context.styleHint?.userLaughterEnergy === "high") return list;

  const laughIndices = list.map((p, i) => (endsWithKeyboardLaugh(p) ? i : -1)).filter((i) => i >= 0);
  if (laughIndices.length <= 1) return list;

  const keepIndex = laughIndices[laughIndices.length - 1];
  return list
    .map((p, i) => {
      if (i === keepIndex || !endsWithKeyboardLaugh(p)) return p;
      return p.replace(/\s+(?:k{2,}|ksks|rs+)\s*$/i, "").trim();
    })
    .filter(Boolean);
}

/**
 * Modelo às vezes solta ' (apóstrofo ASCII) no lugar de ? ou cola ', entre palavras.
 */
function fixStrayApostropheArtifacts(text) {
  return String(text)
    .replace(/([a-záéíóúàâêôãõç])'\s*,\s*([a-záéíóúàâêôãõ])/gi, "$1, $2")
    .replace(/\b(ufa|mds|poxa|nossa|aff)\s*'(?=\s|[.!?]|$)/gi, "$1")
    .replace(/\bpra onde\s*'(?=\s|[.!?]|$)/gi, "pra onde?")
    .replace(/\b(onde|cadê|qual|como|quando|que|pq)\s*'(?=\s|[.!?]|$)/gi, "$1?");
}

/** Travessão/en-dash no zap soa IA — troca por pontuação de conversa. */
function stripAiDashes(text = "") {
  let t = String(text ?? "");
  t = t.replace(/\s+[—–]\s+/g, ", ");
  t = t.replace(/\s+[—–]/g, ", ");
  t = t.replace(/[—–]\s+/g, ", ");
  t = t.replace(/([^\s—–])[—–]([^\s—–])/g, "$1, $2");
  t = t.replace(/^[—–]+/gm, "");
  t = t.replace(/,\s*,+/g, ", ");
  t = t.replace(/\s+,/g, ",");
  return t.trim();
}

function repairPunctuation(text) {
  return String(text)
    .replace(
      /\b(de boa|boa|bem)\s+(E)\s+(você|voce)(?=\s|[,.!?…]|$)/gi,
      "$1. $2 $3"
    )
    // split sentences when a new sentence starts mid-line (skip proper nouns mid-sentence)
    .replace(/([a-záéíóúàâêôãõç])\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúàâêôãõç]+)/g, (m, before, word) => {
      if (PROPER_NOUNS.has(word.toLowerCase())) return m;
      if (MID_SENTENCE_CAPITAL.has(word.toLowerCase())) return m;
      return `${before}. ${word}`;
    })
    // fix spacing before punctuation
    .replace(/\s+([!?.,…])/g, "$1")
    // collapse ugly punctuation combos introduced by removals
    .replace(/([!?.,])\s*([!?.,])/g, (m, a, b) => {
      // keep stronger terminal punctuation when mixed
      const strength = { "!": 3, "?": 3, "…": 3, ".": 2, ",": 1 };
      return (strength[b] ?? 0) >= (strength[a] ?? 0) ? b : a;
    })
    .replace(/([!?.,…]){2,}/g, (seq) => seq.charAt(seq.length - 1))
    // remove orphan separators
    .replace(/(^|[\s])[,;:]+([\s]|$)/g, " ")
    // remove empty parentheses
    .replace(/\(\s*\)/g, "")
    // normalize duplicated commas/spacing
    .replace(/\s*,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function preserveParagraphBreaks(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function stripStandaloneLaughter(text) {
  // remove laughs that are acting as filler, keeping content.
  return String(text)
    .replace(/^\s*((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\s*[,!.?…]*\s*/i, "")
    .replace(/\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b\s*[,!.?…]*/gi, "")
    .replace(/\s+(kk+|rs+)\s*$/i, "")
    .trim();
}

function softenOveractedStart(text) {
  return String(text)
    .replace(/^(ooo+h+[,!\s]*)/i, "")
    .replace(/^(ah+a+h+a+[,\s!]*)/i, "")
    .replace(/^(oiê+[,!\s]*)/i, "Oi! ")
    .trim();
}

function removeBreadDerail(text, userMessage) {
  const u = String(userMessage ?? "").toLowerCase();
  if (/\b(pão|pao|baguete)\b/.test(u)) return String(text);
  return String(text)
    .replace(/\b(baguete(s)?|pão|pao)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Remove ideogramas/hangul que o modelo às vezes alucina no meio do português. */
function stripForeignScripts(text) {
  return String(text)
    .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripEnglishIntrusions(text) {
  return String(text)
    .replace(/\b([a-z]{3,})\*(?=\s|$)/gi, (match, word) => {
      const w = String(word).toLowerCase();
      if (ENGLISH_TOKENS.test(w)) return "";
      if (/^(the|and|you|your|dont|cant|wont|please|thanks|sorry|cool|nice|yeah|yep|nope|lol|working|work|well|okay|okays)$/i.test(w)) {
        return "";
      }
      return match;
    })
    .replace(ENGLISH_FILLERS, "")
    .replace(ENGLISH_TOKENS, "")
    .replace(/\b(so|pleasant\w*|sorry|cool|nice|lol|thank\w*)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function pickPronounMode(pronounsRaw) {
  const t = String(pronounsRaw ?? "").toLowerCase();
  if (!t) return "auto";
  if (/(elu|delu|ile|ielu|ile)/.test(t)) return "neuter";
  if (/(ela|dela)/.test(t)) return "fem";
  if (/(ele|dele)/.test(t)) return "masc";
  return "auto";
}

function fixGenderedPossessives(text, pronounMode = "auto") {
  const t = String(text ?? "");
  return t.replace(
    /\b(seu|teu|meu|sua|tua|minha)\s+([a-záéíóúàâêôãõç]{3,})\b/gi,
    (m, poss, word) => {
      const lowerWord = String(word).toLowerCase();
      if (MASC_A_WORDS.has(lowerWord)) return m;
      if (!/(a|as|osa|osa?s|eira|eiras|ona|onas|inha|inhas|uda|udas|ita|itas|vela|velas|tinha|tinhas|zinha|zinhas)$/i.test(lowerWord)) {
        return m;
      }
      const mode = pronounMode || "auto";
      if (mode === "neuter") {
        const neuterMap = { seu: "delu", teu: "delu", meu: "minha", sua: "delu", tua: "delu", minha: "minha" };
        const key = String(poss).toLowerCase();
        const replacement = neuterMap[key] ?? poss;
        return `${replacement} ${word}`;
      }
      if (mode === "masc") return m;
      const femMap = { seu: "sua", teu: "tua", meu: "minha" };
      const key = String(poss).toLowerCase();
      const replacement = femMap[key] ?? poss;
      return `${replacement} ${word}`;
    }
  );
}

/** WhatsApp não renderiza markdown — títulos/nomes saem com ** ou ~ se o modelo usar. */
function stripChatMarkdown(text = "") {
  let t = String(text ?? "");
  t = t.replace(/~([^~\n]+?)~/g, "$1");
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
  t = t.replace(/__([^_\n]+?)__/g, "$1");
  t = t.replace(/_([^_\n]+?)_/g, "$1");
  t = t.replace(/(?<!\w)\*([^*\n]+?)\*(?!\*)/g, "$1");
  t = t.replace(/\*\*/g, "");
  t = t.replace(/__/g, "");
  t = t.replace(/~+/g, "");
  return t;
}

function sanitize(text, meta = {}) {
  const cleaned = preserveParagraphBreaks(
    stripChatMarkdown(
      stripEnglishIntrusions(stripForeignScripts(String(text)))
    )
      .replace(ROLEPLAY_MARKERS, "")
      .replace(AI_DISCLAIMER, "")
      .replace(/\b(comment|like|share|post|subscribe)\b/gi, "")
      .replace(/[\\]/g, "")
      .replace(ENGLISH_TOKENS, "")
      .replace(IDENTITY_LOOPS, "")
      .replace(META_TALK, "")
      .replace(REMINDER_TALK, "")
      .replace(TITLE_TALK, "")
      .replace(/\b(pessoa real|sou real)\b/gi, "")
      .replace(/!{3,}/g, "!!")
  );

  const pronounMode = pickPronounMode(meta?.userPronouns);

  return fixStrayApostropheArtifacts(
    repairPunctuation(
      stripAiDashes(
      normalizeLaughter(
        fixGenderedPossessives(cleaned, pronounMode)
          .replace(/\brs\b/gi, "")
          .replace(/[ \t]{2,}/g, " ")
          .trim()
      ))
    )
  );
}

function isBubbleSeparatorOnly(text) {
  return /^-{2,}$/.test(String(text ?? "").trim());
}

/** Contrato do agent: linha só com --- separa bolhas explícitas. */
function splitExplicitBubbles(text) {
  const s = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  const byLine = s.split(/\n\s*---\s*\n/).map((p) => p.trim()).filter((p) => p && !isBubbleSeparatorOnly(p));
  if (byLine.length > 1) return byLine;
  const inline = s.split(/\s+---\s+/).map((p) => p.trim()).filter((p) => p && !isBubbleSeparatorOnly(p));
  if (inline.length > 1) return inline;
  if (isBubbleSeparatorOnly(s)) return [];
  return [s];
}

/** Quebra de linha do modelo = bolha separada (antes do sanitize juntar tudo). */
function splitNewlineBubbles(text) {
  const s = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!s.includes("\n")) return [s];
  const lines = s.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return lines.length > 1 ? lines : [s];
}

function splitMultiBubbleIntent(text) {
  const explicit = splitExplicitBubbles(text);
  if (explicit.length > 1) return explicit;
  return splitNewlineBubbles(text);
}

/** Linha única estilo zap: quebra só em conectores claros (evita fatiar palavras comuns). */
function splitCapitalThoughtBoundaries(text) {
  const s = String(text ?? "").trim();
  if (!s || s.length < 12) return [s];
  if (/\n/.test(s) || /\s---\s/.test(s)) return [s];

  const connectors = [
    /(?<=[a-záéíóúàâêôãõç])\s+(?=E\s+(?:você|voce)\b)/iu,
    /(?<=[a-záéíóúàâêôãõç])\s+(?=Mas\s+)/iu,
    /(?<=[a-záéíóúàâêôãõç])\s+(?=Só\s+)/iu,
    /(?<=[a-záéíóúàâêôãõç])\s+(?=(?:Aff|Oxi|Ué|Mds|Nossa|Poxa)\s+)/iu
  ];

  let pieces = [s];
  for (const re of connectors) {
    const next = [];
    for (const chunk of pieces) {
      const parts = chunk.split(re).map((p) => p.trim()).filter(Boolean);
      next.push(...(parts.length > 1 ? parts : [chunk]));
    }
    pieces = next;
  }

  return pieces.length >= 2 ? pieces : [s];
}

function isVocativeNameBubble(text) {
  const t = String(text ?? "")
    .trim()
    .replace(/[.!?…*]+$/, "");
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length !== 1) return false;
  if (words[0].length < 3 || words[0].length > 18) return false;
  return /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(words[0]);
}

function splitSentences(text) {
  const s = String(text).replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  const acc = [];
  for (const line of s.split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    const matches = t.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g);
    if (matches) {
      for (const m of matches) {
        const x = m.trim();
        if (x) acc.push(x);
      }
    } else {
      acc.push(t);
    }
  }
  return acc;
}

function splitByComma(sentence) {
  const raw = String(sentence ?? "").trim();
  if (!raw) return [];
  const hadTrailingComma = /,\s*$/.test(raw);
  const core = hadTrailingComma ? raw.replace(/,\s*$/, "") : raw;
  const parts = core.split(/,\s+/).map((part) => part.trim()).filter((part) => part.length > 2);
  if (parts.length <= 1) return [raw];
  return parts;
}

/**
 * Quando o modelo manda uma linha só (sem .,!?), ainda dá para virar multi-bolha estilo zap.
 */
function splitLongChatLine(sentence) {
  const t = String(sentence ?? "").trim();
  if (!t) return [];

  const byComma = splitByComma(t);
  if (byComma.length > 1) return byComma;

  if (t.length < 24) return [t];

  const byDash = t.split(/\s+[—–]\s+/).map((p) => p.trim());
  if (byDash.length >= 2 && byDash.every((p) => p.length >= 10)) return byDash.filter(Boolean);

  const tagEnd = t.match(/^(.{14,}?)\s+(né\??|néh|né\s*kkk+|néh\s*kkk+)\s*$/i);
  if (tagEnd) {
    const body = tagEnd[1].trim();
    const tail = tagEnd[2].trim();
    if (body.length >= 12 && tail.length >= 2) return [body, tail];
  }

  const masSplit = t.match(/^(.{16,}?)\s+((?:mas|só que)\s+.+)$/i);
  if (masSplit && masSplit[2].trim().length >= 12) {
    return [masSplit[1].trim(), masSplit[2].trim()];
  }

  return [t];
}

function isReactionOnly(sentence) {
  const text = String(sentence ?? "").trim();
  if (!text) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 4 || text.length > 22) return false;
  return /^(ah+|ahh+|boa|blz|beleza|ok+|okk+|certo|perfeito|show|ufa|entendi|poxa|nossa|opa|ei|oi|hm+|hmm+|sim|fechou)[!.?]*$/i.test(text);
}

function splitReactionLead(sentence) {
  const trimmed = String(sentence ?? "").trim();
  const match = trimmed.match(/^(ah+|ahh+|boa|blz|beleza|ok+|okk+|certo|perfeito|show|ufa|entendi|poxa|nossa|opa|ei)[,!.?]+\s+(.+)$/i);
  if (!match) return [trimmed];
  const lead = match[1].trim();
  const rest = match[2].trim();
  if (!lead || !rest) return [trimmed];
  return [lead, rest];
}

function isCorrectionStart(sentence) {
  return /^(pera|perai|na real|quer dizer|ou melhor|ali[aá]s)\b/i.test(String(sentence ?? "").trim());
}

function isTopicShift(sentence) {
  return /^(por falar|mudando de assunto|sobre isso|sobre aquilo|outra coisa|e outra|mais uma)\b/i.test(
    String(sentence ?? "").trim()
  );
}

function isQuestion(sentence) {
  return String(sentence ?? "").trim().endsWith("?");
}

/** Bolha curta que deve poder ficar sozinha (ex.: “Opa”, “Oi”, “De novo?”). */
function isInterjectionBubble(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return /^(opa|oi|oie+|oii|eae|ufa|poxa|nossa|blz|show|sim|não|kk|kkk+|rs+|ha+|né|né\?)$/i.test(t);
  }
  if (words.length === 2) {
    return /^(de novo|tá bom|ta bom|tô aqui|to aqui|muito bem|por favor|tô bem|to bem)$/i.test(t);
  }
  return false;
}

/** Correção estilo zap: trecho curto terminando em * (não juntar com bolha anterior). */
function isCorrectionBubble(text) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 56) return false;
  return /\*$/u.test(t) && t.split(/\s+/).filter(Boolean).length <= 8;
}

function sanitizeCorrectionBubble(text) {
  const t = String(text ?? "").trim();
  if (!t) return t;
  if (!/\*$/.test(t)) return t;
  const body = t.replace(/\*+$/, "").trim();
  if (!body) return "";
  if (body.length < 2) return "";
  if (body.length > 36) return "";
  if (!/[\p{L}]/u.test(body)) return "";
  return `${body}*`;
}

/** Remove correções inválidas (ex.: inglês aleatório, lixo) e mantém bolhas curtas com letras. */
function filterInvalidCorrectionBubbles(parts) {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part) => {
      if (!isCorrectionBubble(part)) return part;
      return sanitizeCorrectionBubble(part);
    })
    .filter(Boolean);
}

function isEnglishLikeWord(word) {
  const w = String(word ?? "");
  if (!w) return false;
  if (ENGLISH_TOKENS.test(w) || ENGLISH_FILLERS.test(w)) return true;
  if (/\b\w+ing\b/i.test(w)) return true;
  return false;
}

function mutateWord(word) {
  const w = String(word ?? "");
  if (w.length < 4) return null;
  if (/\d/.test(w)) return null;
  if (!/[\p{L}]/u.test(w)) return null;
  if (isEnglishLikeWord(w)) return null;
  const lower = w.toLowerCase();
  if (/^(não|nao|sim|ok|oi|oie+|eae|kk+|rs+|tô|to|tá|ta|tb|tbm)$/i.test(lower)) return null;

  const ops = [
    (s) => s.slice(0, -1),
    (s) => s.slice(0, 1) + s.slice(2),
    (s) => s.slice(0, 1) + s[2] + s[1] + s.slice(3),
    (s) => s.slice(0, -2) + s.slice(-1) + s.slice(-2, -1),
    (s) => s.replace(/([a-záéíóúàâêôãõç])\1/i, "$1")
  ];
  const shuffled = ops.map((op) => ({ op, r: Math.random() })).sort((a, b) => a.r - b.r);
  for (const { op } of shuffled) {
    const mutated = op(w);
    if (mutated && mutated !== w && mutated.length >= 3) return mutated;
  }
  return null;
}

function injectDynamicTypo(parts) {
  const arr = Array.isArray(parts) ? [...parts] : [];
  if (!arr.length) return arr;
  const first = String(arr[0] ?? "");
  const words = first.split(/\s+/);
  if (words.length < 3) return arr;

  const candidateIndexes = words
    .map((w, i) => ({ w, i }))
    .filter(({ w, i }) => {
      if (i === 0) return false;
      if (w.length < 4) return false;
      if (!/[\p{L}]/u.test(w)) return false;
      if (isEnglishLikeWord(w)) return false;
      if (/^(kk+|rs+|oi+|oie+|eae+|opa|mds|poxa|ah+|uff?|ufa|hm+|hmm+)$/i.test(w)) return false;
      return true;
    });
  if (!candidateIndexes.length) return arr;

  const pick = candidateIndexes[Math.floor(Math.random() * candidateIndexes.length)];
  const mutated = mutateWord(pick.w);
  if (!mutated) return arr;

  const corrected = pick.w.replace(/[!?.,;:]+$/, "");
  words[pick.i] = mutated;
  const typoLine = words.join(" ");
  return [typoLine, `${corrected}*`, ...arr.slice(1)];
}

function mergeTinyFragments(parts) {
  const merged = [];
  for (const part of parts) {
    const cleaned = String(part).trim();
    if (!cleaned) continue;
    if (!merged.length) {
      merged.push(cleaned);
      continue;
    }
    if (
      cleaned.length < 10 &&
      cleaned.split(/\s+/).length <= 2 &&
      !isInterjectionBubble(cleaned) &&
      !isCorrectionBubble(cleaned) &&
      !isVocativeNameBubble(cleaned)
    ) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${cleaned}`.trim();
      continue;
    }
    merged.push(cleaned);
  }
  return merged;
}

function isSensitiveMessage(text) {
  const t = String(text ?? "").toLowerCase();
  return /\b(ansiedade|depress|luto|morte|suic|trauma|abuso|doen[çc]a|hospital|urgente|socorro)\b/.test(t);
}

function stripUserEchoParts(parts, userMessage = "") {
  const u = String(userMessage ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  if (!u) return parts;
  const uWords = u.split(/\s+/).filter((w) => w.length > 2);
  if (uWords.length < 2) return parts;

  return (Array.isArray(parts) ? parts : []).filter((part) => {
    const p = String(part ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const chunk = uWords.slice(0, Math.min(5, uWords.length)).join(" ");
    if (chunk.length >= 8 && p.includes(chunk)) return false;
    const overlap = uWords.filter((w) => p.includes(w));
    return overlap.length < Math.max(3, Math.ceil(uWords.length * 0.55));
  });
}

function dropMetaQuestions(text) {
  const sentences = splitSentences(String(text));
  const filtered = sentences.filter((s) => {
    const t = s.trim();
    if (!t.endsWith("?")) return true;
    const lower = t.toLowerCase();
    // Drop common meta-mirror questions that don't add information.
    if (/^(você|vc)\b/.test(lower) && /\b(quer|quer saber|tá|ta|está|esta|pergunt|tipo)\b/.test(lower)) {
      return false;
    }
    if (/\b(pq|por que|por quê)\b\??\s*$/.test(lower) && lower.length < 40) {
      return false;
    }
    return true;
  });

  return (filtered.length ? filtered : sentences).join(" ").trim();
}

function dropTrailingFiller(parts) {
  const list = Array.isArray(parts) ? [...parts] : [];
  if (!list.length) return list;
  const last = String(list[list.length - 1] ?? "").trim();
  if (/^(né|ne|kk+|rs+|tá\?|ta\?|ok|blz|beleza|tipo|assim|sei lá)$/i.test(last)) {
    return list.slice(0, -1);
  }
  return list;
}

function isLikelyQuestion(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (/\?$/.test(t)) return true;
  return /^(o que|oq|quem|quando|onde|por que|porque|pq|qual|como|cad[eê]|ce|cê|vc|você|vai|ta|tá|é|eh)\b/.test(t);
}

function enforceTerminalPunctuation(text) {
  const t = String(text ?? "").trim();
  if (!t) return t;
  if (/[*]$/.test(t)) return t;
  if (/[.!?…]$/.test(t)) return t;
  if (isInterjectionBubble(t)) return t;
  if (isLikelyQuestion(t) && !/\?$/.test(t)) return `${t}?`;
  return t;
}

function capitalize(text) {
  if (!text) return text;
  const cleaned = String(text).trimStart();
  if (!cleaned) return cleaned;
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

function applyGreetingIntensity(text, userMessage, styleHint = null) {
  const source = String(userMessage ?? "").trim().toLowerCase();
  const target = String(text ?? "");
  if (!source || !target) return target;

  const intensity = Number(styleHint?.userGreetingIntensity ?? 0);
  if (intensity <= 0) return target;
  if (!/^(oi+|oie+|eae+|hey+)/i.test(source)) return target;

  const maxExtra = Math.min(2, intensity);
  return target.replace(/^(oi|oie)\b/i, (m) => `${m}${"e".repeat(maxExtra)}`);
}

function mergeShortParts(parts) {
  const merged = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);
    const tiny =
      merged.length &&
      !isInterjectionBubble(trimmed) &&
      !isCorrectionBubble(trimmed) &&
      words.length <= 2 &&
      trimmed.length < 10 &&
      !/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(trimmed);
    if (tiny) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${trimmed}`.trim();
      continue;
    }
    merged.push(trimmed);
  }

  return mergeTinyFragments(merged).map((text) => text.replace(/^,\s*/g, "").trim());
}

function chunkSentences(sentences, maxParts = Infinity) {
  if (sentences.length <= 2) return [sentences.join(" ")];

  const parts = [];
  const target = Math.ceil(sentences.length / Math.min(maxParts, sentences.length));
  let buffer = [];

  for (const sentence of sentences) {
    buffer.push(sentence);
    const bufferText = buffer.join(" ");
    if (bufferText.length > 140 || buffer.length >= target) {
      parts.push(bufferText);
      buffer = [];
    }
  }

  if (buffer.length) {
    parts.push(buffer.join(" "));
  }

  return parts;
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúàèìòùâêîôûãõç\s]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityScore(a, b) {
  const setA = new Set(normalize(a).split(" "));
  const setB = new Set(normalize(b).split(" "));
  if (!setA.size || !setB.size) return 0;
  const overlap = [...setA].filter((word) => setB.has(word)).length;
  return overlap / Math.max(setA.size, setB.size);
}

function shouldSkipTypoPlay(context = {}) {
  return Boolean(context.styleHint?.userSkipTypoCorrection);
}

function shouldKeepLoosePunctuation(context = {}) {
  return Boolean(
    context.styleHint?.userSkipTypoCorrection ||
    context.styleHint?.userMeltyTyping ||
    context.styleHint?.userLowPunctuation
  );
}

function processPreservedBubble(rawText, context = {}) {
  const cleaned = sanitize(rawText, { userPronouns: context.userPronouns });
  if (!cleaned || cleaned.length <= 1 || isBubbleSeparatorOnly(cleaned)) return null;

  let part = capitalize(cleaned);
  part = swapEmojiLaughterForKkk(part, context.styleHint, context.tone);
  part = dropMetaQuestions(part);
  part = softenOveractedStart(part);
  part = removeBreadDerail(part, context.userMessage);
  part = normalizeInformalEnding(part);
  part = applyGreetingIntensity(part, context.userMessage, context.styleHint);
  if (context.styleHint?.userCapsBurst) {
    part = part.replace(/\b(não|nao)\b/gi, (m) => m.toUpperCase());
  }
  if (!shouldKeepLoosePunctuation(context)) {
    part = enforceTerminalPunctuation(String(part).replace(/\s{2,}/g, " ").trim());
  } else {
    part = String(part).replace(/\s{2,}/g, " ").trim();
  }
  return part || null;
}

function polishBubbleList(finalParts, context = {}, processor = null) {
  const { tone = null, userMessage = "", styleHint = null } = context;
  let parts = (Array.isArray(finalParts) ? finalParts : []).map((p) => String(p).trim()).filter(Boolean);
  if (!parts.length) return [];

  const combinedBefore = parts.join(" ");
  const hasAnyLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(combinedBefore);
  const userUsesLaughter =
    /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(String(userMessage)) ||
    isMessyLaughterMessage(userMessage);
  const userLikesLaughter =
    userUsesLaughter ||
    styleHint?.prefersLaughter ||
    styleHint?.preferredLaughter === "kk" ||
    styleHint?.userLaughterEnergy === "high" ||
    styleHint?.userLaughterEnergy === "medium";
  const shouldSuppressLaughter =
    tone === "calm" || ((processor?.laughterCooldown ?? 0) > 0 && !userLikesLaughter && tone !== "playful");
  if (hasAnyLaughter && shouldSuppressLaughter) {
    parts = parts.map(stripStandaloneLaughter).filter(Boolean);
  }
  const combinedAfter = parts.join(" ");
  const stillHasLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(combinedAfter);
  if (processor) {
    if (stillHasLaughter) {
      processor.laughterCooldown = 2;
    } else {
      processor.laughterCooldown = Math.max(0, processor.laughterCooldown - 1);
    }
  }

  const combined = parts.join(" ");
  const hasKk = /\bkk+\b/i.test(combined);
  if (processor?.lastHadLaughter && hasKk && !userLikesLaughter) {
    parts = parts.map(stripStandaloneLaughter).filter(Boolean);
  }
  if (processor) {
    processor.lastHadLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(
      parts.join(" ")
    );
  }

  parts = trimRedundantKkk(parts, { userMessage, styleHint, tone });

  parts = dropTrailingFiller(parts);
  parts = stripUserEchoParts(parts, userMessage);
  if (context._explicitMultiBubble) {
    parts = parts.filter(Boolean);
  } else {
    parts = repairBubbleCoherence(parts);
    parts = parts.filter((part) => !isIncompleteBubble(part));
  }
  if (!context._explicitMultiBubble) {
    parts = collapseForShortUserPrompt(parts, userMessage);
  }
  parts = filterInvalidCorrectionBubbles(parts);
  if (!shouldSkipTypoPlay(context)) {
    if (processor?.canInjectImperfection?.({ tone, userMessage }) && Math.random() < 0.05) {
      parts = injectDynamicTypo(parts);
      processor.imperfectionEvents.push(Date.now());
      processor.imperfectionCooldown = 10;
    }
    if (processor?.applyCalibratedImperfection) {
      parts = processor.applyCalibratedImperfection(parts, { tone, userMessage });
    }
  }
  return parts.filter(Boolean);
}

export class ResponseProcessor {
  /** maxParts: número finito = teto opcional; Infinity = só o que o texto naturalmente gerar */
  constructor({ maxParts = Infinity, similarityThreshold = 0.75, historyLimit = 5 } = {}) {
    this.maxParts = maxParts;
    this.similarityThreshold = similarityThreshold;
    this.historyLimit = historyLimit;
    this.history = [];
    this.lastHadLaughter = false;
    this.laughterCooldown = 0;
    this.imperfectionEvents = [];
    this.maxImperfectionsPerWindow = 5;
    this.imperfectionWindowMs = 10 * 60 * 1000;
    this.imperfectionCooldown = 0;
    this.lastBubblePlan = null;
  }

  buildNaturalParts(sentences) {
    const list = sentences.map((s) => s.trim()).filter(Boolean);
    const joined = list.join(" ");
    const totalLength = joined.length;

    if (list.length <= 1) {
      return [joined];
    }

    // Só junta 2 frases numa bolha se forem micro-fragmentos (evita matar multi-bolha útil)
    if (list.length === 2 && totalLength <= 22) {
      const [a, b] = list;
      if (a.length <= 11 && b.length <= 11) {
        return [joined];
      }
    }

    // Até 6 frases e tamanho típico de chat: uma candidata a bolha por frase
    if (list.length >= 2 && list.length <= 6 && totalLength <= 520) {
      return list;
    }

    // Textos longos / muitas frases: agrupa por pausas naturais
    const parts = [];
    let buffer = [];
    let charCount = 0;
    let stopSplitting = false;

    for (const sentence of list) {
      buffer.push(sentence);
      charCount += sentence.length;

      if (stopSplitting) {
        continue;
      }

      const lower = sentence.toLowerCase();
      const isQuestion = sentence.trim().endsWith("?");
      const isSoftBreak = /\b(mas|então|enfim|tipo|porque|pq)\b/.test(lower);
      const shouldPause =
        isQuestion ||
        (isSoftBreak && charCount > 75) ||
        charCount > 130;

      if (shouldPause) {
        if (Number.isFinite(this.maxParts) && parts.length >= this.maxParts - 1) {
          stopSplitting = true;
          continue;
        }

        parts.push(buffer.join(" "));
        buffer = [];
        charCount = 0;
      }
    }

    if (buffer.length) {
      if (!Number.isFinite(this.maxParts) || parts.length < this.maxParts) {
        parts.push(buffer.join(" "));
      } else {
        parts[parts.length - 1] = `${parts[parts.length - 1]} ${buffer.join(" ")}`.trim();
      }
    }

    return parts.length ? parts : [joined];
  }

  buildHumanParts(parts, { userMessage = "" } = {}) {
    const sourceParts = Array.isArray(parts) ? parts : [String(parts ?? "")];
    const flattened = sourceParts
      .map((part) => splitSentences(String(part ?? "")))
      .flat()
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    if (!flattened.length) return [];

    const output = [];
    let buffer = [];

    const flush = () => {
      if (!buffer.length) return;
      output.push(buffer.join(" ").trim());
      buffer = [];
    };

    for (let index = 0; index < flattened.length; index += 1) {
      const sentence = flattened[index];
      if (!sentence) continue;

      const reactionSplit = splitReactionLead(sentence);
      if (reactionSplit.length === 2) {
        flush();
        output.push(reactionSplit[0]);
        buffer.push(reactionSplit[1]);
        continue;
      }

      if (isReactionOnly(sentence)) {
        flush();
        output.push(sentence);
        continue;
      }

      if (buffer.length) {
        const prev = buffer[buffer.length - 1];
        if (isQuestion(prev)) {
          flush();
        }
      }

      if (!buffer.length && isCorrectionStart(sentence)) {
        flush();
      }

      buffer.push(sentence);

      const bufferText = buffer.join(" ");
      const shouldSplit =
        isQuestion(sentence) ||
        isCorrectionStart(sentence) ||
        isTopicShift(sentence) ||
        bufferText.length > 115;

      if (shouldSplit) {
        flush();
      }
    }

    flush();

    const merged = mergeShortParts(output)
      .map((part) => part.trim())
      .filter(Boolean);

    const capped = Number.isFinite(this.maxParts) ? merged.slice(0, this.maxParts) : merged;
    if (!capped.length) return [];

    return capped;
  }

  process(rawText, { tone = null, userMessage = "", styleHint = null, userPronouns = null, _skipExplicitSplit = false, _explicitMultiBubble = false } = {}) {
    if (!_skipExplicitSplit) {
      const segments = splitMultiBubbleIntent(rawText);
      if (segments.length > 1) {
        const finalParts = polishBubbleList(
          segments.map((segment) => processPreservedBubble(segment, { tone, userMessage, styleHint, userPronouns })).filter(Boolean),
          { tone, userMessage, styleHint, _explicitMultiBubble: true },
          this
        );
        return finalParts.length ? finalParts : [];
      }
    }

    const single = processPreservedBubble(rawText, { tone, userMessage, styleHint, userPronouns });
    const finalParts = polishBubbleList(
      single ? [single] : [],
      { tone, userMessage, styleHint, _explicitMultiBubble },
      this
    );
    if (finalParts.length) return finalParts;

    const cleaned = sanitize(rawText, { userPronouns });
    const fallback = capitalize(stripStandaloneLaughter(cleaned));
    return fallback ? [fallback] : [];
  }

  /** Unifica process + anti-repetição + remember para regen. */
  processAndGuard(rawText, context = {}) {
    const parts = this.process(rawText, context);
    let safeParts = parts
      .map((part) => this.ensureNonRepetitive(part))
      .map((part) => String(part).replace(/\s{2,}/g, " ").trim())
      .filter(Boolean);

    const skipBrainRhythm =
      context.coherenceFix === true ||
      (!context.brainSnapshot && !context.brainBlocks);
    if (!skipBrainRhythm && safeParts.length) {
      const plan = planBubbleRhythm(safeParts, {
        brainSnapshot: context.brainSnapshot,
        brainBlocks: context.brainBlocks,
        timingPlan: context.timingPlan,
        tone: context.tone,
        emotion: context.brainSnapshot?.emotion
      });
      this.lastBubblePlan = plan;
      safeParts = plan.bubbles;
    } else {
      this.lastBubblePlan = { bubbles: safeParts, delays: [], mode: "moderate" };
    }

    const combined = safeParts.join(" ").trim();
    const safeCombined = this.ensureNonRepetitive(combined);
    this.remember(safeCombined);
    return safeParts.length ? safeParts : [safeCombined].filter(Boolean);
  }

  canInjectImperfection({ tone, userMessage }) {
    if (tone === "calm") return false;
    if (isSensitiveMessage(userMessage)) return false;
    if (this.imperfectionCooldown > 0) {
      this.imperfectionCooldown -= 1;
      return false;
    }
    const now = Date.now();
    this.imperfectionEvents = this.imperfectionEvents.filter(
      (timestamp) => now - timestamp < this.imperfectionWindowMs
    );
    return this.imperfectionEvents.length < this.maxImperfectionsPerWindow;
  }

  applyCalibratedImperfection(parts, context = {}) {
    const safeParts = Array.isArray(parts) ? [...parts] : [];
    if (!safeParts.length || !this.canInjectImperfection(context)) return safeParts;
    const first = String(safeParts[0] ?? "");
    if (!first || first.length > 160 || /^\s*\*/.test(first)) return safeParts;
    if (safeParts.length > 1 && isCorrectionBubble(String(safeParts[1] ?? ""))) return safeParts;
    if (Math.random() > 0.48) return safeParts;

    const tricks = [
      { re: /\bentendi\b/i, bad: (s) => s.replace(/\bentendi\b/i, "entnedi"), fix: "entendi*" },
      { re: /\bimagina\b/i, bad: (s) => s.replace(/\bimagina\b/i, "magina"), fix: "imagina*" },
      { re: /\bclaro\b/i, bad: (s) => s.replace(/\bclaro\b/i, "claor"), fix: "claro*" },
      { re: /\bvocê\b/i, bad: (s) => s.replace(/\bvocê\b/i, "voce"), fix: "você*" },
      { re: /\bobrigada\b/i, bad: (s) => s.replace(/\bobrigada\b/i, "obirgada"), fix: "obrigada*" },
      { re: /\bobrigado\b/i, bad: (s) => s.replace(/\bobrigado\b/i, "obirgado"), fix: "obrigado*" },
      { re: /\bperaí\b/i, bad: (s) => s.replace(/\bperaí\b/i, "perai"), fix: "peraí*" },
      { re: /\btranquilo\b/i, bad: (s) => s.replace(/\btranquilo\b/i, "tranqulo"), fix: "tranquilo*" },
      { re: /\bvamos\b/i, bad: (s) => s.replace(/\bvamos\b/i, "vamo"), fix: "vamos*" }
    ]
      .map((x) => ({ ...x, _o: Math.random() }))
      .sort((a, b) => a._o - b._o);

    for (const t of tricks) {
      if (!t.re.test(first)) continue;
      const bad = t.bad(first);
      if (bad === first) continue;
      const rest = safeParts.slice(1);
      const fixBubble = t.fix.endsWith("*") ? t.fix : `${t.fix}*`;
      safeParts.length = 0;
      safeParts.push(bad, fixBubble, ...rest);
      this.imperfectionEvents.push(Date.now());
      return safeParts;
    }

    return safeParts;
  }

  isRepetitive(text) {
    return this.history.some(
      (prev) => similarityScore(prev, text) >= this.similarityThreshold
    );
  }

  ensureNonRepetitive(text) {
    if (!this.isRepetitive(text)) return text;

    const sentences = splitSentences(text);
    if (sentences.length > 1) {
      return sentences.slice(0, Math.max(1, sentences.length - 1)).join(" ");
    }

    return text;
  }

  remember(text) {
    this.history.push(text);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }
  }
}
