import { isMessyLaughterMessage } from "../../core/memory/extractor.js";

const ROLEPLAY_MARKERS = /\*[^*]{1,20}\*/g;
const IDENTITY_LOOPS = /\b(eu sou (a )?kasane teto|eu sou a própria kasane teto|sou kasane teto)\b/gi;
const META_TALK = /\b(você disse|você perguntou|você falou|sua mensagem|você (tá|ta|está|esta) (perguntando|achando|dizendo))\b/gi;
const REMINDER_TALK = /\b(lembra\??!?)\b/gi;
const TITLE_TALK = /\b(princesa|rainha)\b/gi;
const AI_DISCLAIMER = /\b(as an ai|as a language model)\b/gi;
const ENGLISH_FILLERS = /\b(by the way|btw|anyway|anyways|i mean|you know|well(?:\s+then)?|cool|nice|yep|yeah|nope|pls|please|thanks|thank you)\b/gi;

function normalizeLaughter(text) {
  // Não achatar kkk longos — só corta sequências absurdas (spam acidental).
  return text.replace(/k{45,}/gi, (m) => `${m.slice(0, 32)}`);
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

function repairPunctuation(text) {
  return String(text)
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
    .replace(/\b(ok|okay|okey|nice|cool|sorry|lol)\b/gi, (m) => m)
    .replace(/\bso\b/gi, "")
    .replace(ENGLISH_FILLERS, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitize(text) {
  const cleaned = preserveParagraphBreaks(
    stripEnglishIntrusions(stripForeignScripts(String(text)))
      .replace(ROLEPLAY_MARKERS, "")
      .replace(AI_DISCLAIMER, "")
      .replace(/\b(comment|like|share|post|subscribe)\b/gi, "")
      .replace(IDENTITY_LOOPS, "")
      .replace(META_TALK, "")
      .replace(REMINDER_TALK, "")
      .replace(TITLE_TALK, "")
      .replace(/\b(pessoa real|sou real)\b/gi, "")
      .replace(/!{3,}/g, "!!")
  );

  return fixStrayApostropheArtifacts(
    repairPunctuation(
      normalizeLaughter(
        cleaned
          .replace(/\brs\b/gi, "")
          .replace(/[ \t]{2,}/g, " ")
          .trim()
      )
    )
  );
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
  const parts = sentence.split(/,\s+/).map((part) => part.trim());
  return parts.filter((part) => part.length > 2);
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
    return /^(de novo|tá bom|ta bom|tô aqui|to aqui|muito bem|por favor)$/i.test(t);
  }
  return false;
}

/** Correção estilo zap: trecho curto terminando em * (não juntar com bolha anterior). */
function isCorrectionBubble(text) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 56) return false;
  return /\*$/u.test(t) && t.split(/\s+/).filter(Boolean).length <= 8;
}

/** Glitches comuns do modelo: bolha extra só com a forma certa + * */
function ensureKnownTypoCorrectionBubbles(parts) {
  const arr = Array.isArray(parts) ? [...parts] : [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const p = String(arr[i] ?? "");
    out.push(p);
    if (/\bveemim\b/i.test(p)) {
      const rest = arr.slice(i + 1);
      const hasFix = rest.some((x) => /v[eê]\s+em\s+mim\*$/i.test(String(x).trim()));
      if (!hasFix) out.push("vê em mim*");
    }
  }
  return out;
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
      !isCorrectionBubble(cleaned)
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

  process(rawText, { tone = null, userMessage = "", styleHint = null } = {}) {
    const cleaned = sanitize(rawText);
    let sentences = splitSentences(cleaned);

    if (sentences.length === 1) {
      const split = splitByComma(sentences[0]);
      if (split.length > 1) {
        sentences = split;
      } else {
        const expanded = splitLongChatLine(sentences[0]);
        if (expanded.length > 1) {
          sentences = expanded;
        }
      }
    }

    const parts = this.buildNaturalParts(sentences);
    const humanParts =
      parts.length > 1
        ? parts.flatMap((p) => {
            const sub = this.buildHumanParts([p], { userMessage });
            return sub.length ? sub : [p];
          })
        : this.buildHumanParts(parts, { userMessage });
    let finalParts = mergeShortParts(humanParts.length ? humanParts : parts)
      .map(capitalize)
      .filter((part) => part.length > 1);

    // Laughter control (dynamic): allow rarely, avoid back-to-back, never in calm.
    const combinedBefore = finalParts.join(" ");
    const hasAnyLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(combinedBefore);
    const userUsesLaughter =
      /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(
        String(userMessage)
      ) || isMessyLaughterMessage(userMessage);
    const shouldSuppressLaughter =
      tone === "calm" ||
      (this.laughterCooldown > 0 && !userUsesLaughter && tone !== "playful");
    if (hasAnyLaughter && shouldSuppressLaughter) {
      finalParts = finalParts.map(stripStandaloneLaughter).filter(Boolean);
    }
    const combinedAfter = finalParts.join(" ");
    const stillHasLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(combinedAfter);
    if (stillHasLaughter) {
      this.laughterCooldown = 2;
    } else {
      this.laughterCooldown = Math.max(0, this.laughterCooldown - 1);
    }

    // Cooldown: avoid laughter in consecutive assistant outputs.
    const combined = finalParts.join(" ");
    const hasKk = /\bkk+\b/i.test(combined);
    if (this.lastHadLaughter && hasKk) {
      finalParts = finalParts.map(stripStandaloneLaughter).filter(Boolean);
    }
    this.lastHadLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(finalParts.join(" "));

    finalParts = finalParts
      .map(dropMetaQuestions)
      .map((part) => softenOveractedStart(part))
      .map((part) => removeBreadDerail(part, userMessage))
      .filter(Boolean);
    // Keep intensity mirroring very subtle to avoid caricature.
    finalParts = finalParts.map((part) => applyGreetingIntensity(part, userMessage, styleHint));
    finalParts = this.applyCalibratedImperfection(finalParts, { tone, userMessage });
    finalParts = ensureKnownTypoCorrectionBubbles(finalParts);

    return finalParts.length ? finalParts : [capitalize(stripStandaloneLaughter(cleaned))].filter(Boolean);
  }

  canInjectImperfection({ tone, userMessage }) {
    if (tone === "calm") return false;
    if (isSensitiveMessage(userMessage)) return false;
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
