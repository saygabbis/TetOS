import { isMessyLaughterMessage, maxConsecutiveKRun } from "./extractor.js";

/** Barulho de teclado / risada caótica (skdsk, akaksaks, ksks). */
export function isKeyboardSmashLine(message = "") {
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 48) return false;
  if (isMessyLaughterMessage(raw)) return true;

  const noSpace = raw.replace(/\s/g, "");
  if (noSpace.length < 4 || noSpace.length > 32) return false;
  if (!/^[a-záéíóúâêôãõç]+$/i.test(noSpace)) return false;
  if (/^(oi+|oie+|ok+|blz|sim|nao|não|tá|ta|hm+)$/i.test(noSpace)) return false;

  const vowels = (noSpace.match(/[aeiouáéíóúâêôãõ]/gi) ?? []).length;
  const ratio = vowels / noSpace.length;
  const consonantRun = /[bcdfghjklmnpqrstvwxyz]{4,}/i.test(noSpace);
  if (ratio >= 0.12 && ratio <= 0.62 && consonantRun) return true;

  // akaksaks, ksksks, skdsk — alternância caótica de teclado/risada
  if (/^[akshjd]{5,12}$/i.test(noSpace) && /[ksh]/i.test(noSpace) && /[aeiouáéíóúâêôãõ]/i.test(noSpace)) {
    return true;
  }
  return false;
}

function countStretchedVowels(text = "") {
  return (String(text).match(/[aeiouáéíóúâêôãõ]\1{2,}/gi) ?? []).length;
}

function hasLoveyTone(text = "") {
  const t = String(text ?? "").toLowerCase();
  return (
    /\b(te amo|eu amo|amo amo|amoa|lind[ao]|linds|lindissim|quer(o|ia)|obrigad|gratid|saudade|saudades|fof[ao]|fofinh|muito voce|muito você|contigo)\b/.test(
      t
    ) || /\b(voce+|você+|teot[o0]+|teto+)\b/i.test(t)
  );
}

function hasLooseTypos(text = "") {
  const t = String(text ?? "").toLowerCase();
  if (/\b(relfao|legao|gsoto|gsto|voceee|tudoo|amoa|moooo)\b/.test(t)) return true;
  if (/\b(ce|cê|vc)\s+(teto|voce|você)\b/.test(t)) return true;
  if (/\b\w*[bcdfghjklmnpqrstvwxyz]{2,}[aeiou]\w*\b/.test(t) && t.length > 20) {
    const words = t.split(/\s+/).filter((w) => w.length >= 4);
    const suspicious = words.filter((w) => /^[a-z]{4,}$/i.test(w) && !/^(teto|gabbis|amor|linda|quero|obrigada|voce|você)$/i.test(w));
    if (suspicious.length >= 2) return true;
  }
  return false;
}

/** Várias linhas ou frases longas quase sem pontuação final. */
export function isLowPunctuationBurst(message = "") {
  const raw = String(message ?? "").trim();
  if (!raw || raw.length < 24) return false;

  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const chunks = lines.length > 1 ? lines : raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length < 2 && raw.length < 80) return false;

  const withoutEndPunct = chunks.filter((c) => c.length > 6 && !/[.!?…]$/.test(c));
  const ratio = withoutEndPunct.length / Math.max(chunks.length, 1);
  return ratio >= 0.55 || (lines.length >= 3 && withoutEndPunct.length >= 2);
}

/**
 * Analisa zap solto: sem pontuação, vogal esticada, typo afetivo, barulho de teclado.
 */
export function analyzeInformalTyping(message = "") {
  const text = String(message ?? "").trim();
  if (!text) {
    return {
      melty: false,
      affectionate: false,
      lowPunctuation: false,
      keyboardSmash: false,
      stretchedVowels: 0,
      skipTypoCorrection: false,
      canMirrorLoose: false
    };
  }

  const stretchedVowels = countStretchedVowels(text);
  const keyboardSmash =
    isKeyboardSmashLine(text) ||
    text.split(/\n+/).some((line) => isKeyboardSmashLine(line));
  const affectionate = hasLoveyTone(text);
  const looseTypos = hasLooseTypos(text);
  const lowPunctuation = isLowPunctuationBurst(text);
  const burstLines = text.split(/\n+/).filter(Boolean).length;
  const kkRun = maxConsecutiveKRun(text);

  const melty =
    affectionate ||
    (stretchedVowels >= 2 && text.length >= 20) ||
    (burstLines >= 3 && lowPunctuation) ||
    (looseTypos && (affectionate || stretchedVowels >= 1));

  const skipTypoCorrection =
    melty || affectionate || keyboardSmash || (looseTypos && stretchedVowels >= 1) || kkRun >= 8;

  return {
    melty,
    affectionate,
    lowPunctuation,
    keyboardSmash,
    stretchedVowels,
    looseTypos,
    burstLines,
    skipTypoCorrection,
    canMirrorLoose: melty || (affectionate && stretchedVowels >= 1)
  };
}

/** Resumo curto pro prompt — ajuda o modelo a decodificar sem pedir repetição. */
export function buildInformalTypingPromptLines(message = "", analysis = null) {
  const a = analysis ?? analyzeInformalTyping(message);
  if (!a.melty && !a.affectionate && !a.lowPunctuation && !a.keyboardSmash) return [];

  const lines = [
    "[ZAP SOLTO — ENTENDA NORMAL]",
    "Digitação sem pontuação, vogal esticada, typo de propósito ou barulho de teclado NÃO é bug — leia a intenção afetiva/conversacional.",
    "Exemplos de leitura: relfao/legao → legal; Gsoto/gsto → gosto; ce/cê → você; teotooooo → Teto; amoa → amo; voceee/voce → você.",
    "Não peça 'fala direito', 'não entendi' ou 'que foi isso?' por causa do jeito de digitar."
  ];

  if (a.keyboardSmash) {
    lines.push("Linhas tipo skdsk/akaksaks/ksks = risada ou empolgação no teclado — reaja no clima, não como erro.");
  }
  if (a.affectionate) {
    lines.push("Tom afetivo/meloso detectado — responda com calor compatível com o vínculo; não fique seca nem formal.");
  }
  if (a.skipTypoCorrection) {
    lines.push(
      "Neste clima: PROIBIDO autocorreção com * (bolha tipo certo* ou voce*). Pode digitar solto como a pessoa — typos espontâneos ok, sem se corrigir."
    );
  }
  if (a.canMirrorLoose) {
    lines.push(
      "Se emoção/intimidade permitirem, pode espelhar leve (oieeee, lindaaa, te amooo) — só se soar natural com ESTA pessoa, não caricatura."
    );
  }

  return lines;
}
