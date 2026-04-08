const ROLEPLAY_MARKERS = /\*[^*]{1,20}\*/g;
const IDENTITY_LOOPS = /\b(eu sou (a )?kasane teto|eu sou a própria kasane teto|sou kasane teto)\b/gi;
const META_TALK = /\b(você disse|você perguntou|você falou|sua mensagem|você (tá|ta|está|esta) (perguntando|achando|dizendo))\b/gi;
const REMINDER_TALK = /\b(lembra\??!?)\b/gi;
const TITLE_TALK = /\b(princesa|rainha)\b/gi;
const AI_DISCLAIMER = /\b(as an ai|as a language model)\b/gi;

function normalizeCaps(text) {
  return text.replace(/\b[A-ZÀ-ÖØ-Þ]{6,}\b/g, (word) =>
    word.charAt(0) + word.slice(1).toLowerCase()
  );
}

function normalizeLaughter(text) {
  return text.replace(/k{4,}/gi, "kk");
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

function sanitize(text) {
  const cleaned = normalizeCaps(
    String(text)
      .replace(ROLEPLAY_MARKERS, "")
      .replace(AI_DISCLAIMER, "")
      .replace(/\b(kidding aside|by the way|btw)\b/gi, "")
      .replace(IDENTITY_LOOPS, "")
      .replace(META_TALK, "")
      .replace(REMINDER_TALK, "")
      .replace(TITLE_TALK, "")
      .replace(/\b(pessoa real|sou real)\b/gi, "")
      .replace(/!{3,}/g, "!!")
  );

  return repairPunctuation(
    normalizeLaughter(
      cleaned
        .replace(/\brs\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    )
  );
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitByComma(sentence) {
  const parts = sentence.split(/,\s+/).map((part) => part.trim());
  return parts.filter((part) => part.length > 3);
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
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    const words = part.split(/\s+/).filter(Boolean);
    if (words.length <= 2 && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${part}`.trim();
      continue;
    }
    merged.push(part.trim());
  }

  return merged.map((text) => text.replace(/^,\s*/g, "").trim());
}

function chunkSentences(sentences, maxParts = 4) {
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
  constructor({ maxParts = 4, similarityThreshold = 0.75, historyLimit = 5 } = {}) {
    this.maxParts = maxParts;
    this.similarityThreshold = similarityThreshold;
    this.historyLimit = historyLimit;
    this.history = [];
    this.lastHadLaughter = false;
    this.laughterCooldown = 0;
  }

  buildNaturalParts(sentences) {
    const totalLength = sentences.join(" ").length;
    // Don't force multi-message for simple replies.
    if (sentences.length < 4 || totalLength < 230) {
      return [sentences.join(" ")];
    }

    const parts = [];
    let buffer = [];
    let charCount = 0;
    let stopSplitting = false;

    for (const sentence of sentences) {
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
        (isSoftBreak && charCount > 110) ||
        charCount > 190;

      if (shouldPause) {
        // If we're about to hit the last allowed part, stop splitting and keep
        // appending everything else into the current buffer.
        if (parts.length >= this.maxParts - 1) {
          stopSplitting = true;
          continue;
        }

        parts.push(buffer.join(" "));
        buffer = [];
        charCount = 0;
      }
    }

    if (buffer.length && parts.length < this.maxParts) {
      parts.push(buffer.join(" "));
    }

    return parts.length ? parts : [sentences.join(" ")];
  }

  process(rawText, { tone = null, userMessage = "", styleHint = null } = {}) {
    const cleaned = sanitize(rawText);
    let sentences = splitSentences(cleaned);

    if (sentences.length === 1 && Math.random() < 0.1) {
      const split = splitByComma(sentences[0]);
      if (split.length > 1) {
        sentences = split;
      }
    }

    const parts = this.buildNaturalParts(sentences);
    let finalParts = mergeShortParts(parts)
      .map(capitalize)
      .filter((part) => part.length > 1);

    // Laughter control (dynamic): allow rarely, avoid back-to-back, never in calm.
    const combinedBefore = finalParts.join(" ");
    const hasAnyLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(combinedBefore);
    const userUsesLaughter = /\b((?:k{2,})|(?:rs+)|(?:(?:ha){2,})|(?:(?:he){2,})|(?:(?:hi){2,}))\b/i.test(
      String(userMessage)
    );
    const shouldSuppressLaughter =
      tone === "calm" ||
      this.laughterCooldown > 0 ||
      !userUsesLaughter;
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

    return finalParts.length ? finalParts : [capitalize(stripStandaloneLaughter(cleaned))].filter(Boolean);
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
