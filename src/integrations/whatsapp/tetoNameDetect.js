/** Colapsa letras repetidas: "tetoooo" → "teto", "teeetooo" → "teto" */
export function collapseStretchyLetters(s = "") {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/**
 * Detecta chamadas criativas/erradas ao nome da Teto (grupo/PV).
 * @returns {{ detected: boolean, confidence: number, variant: string|null }}
 */
export function detectTetoNameCall(text = "") {
  const raw = String(text ?? "").trim();
  if (!raw) return { detected: false, confidence: 0, variant: null };

  const lower = raw.toLowerCase();
  const letters = lower.replace(/[^a-z0-9]/g, "");
  const collapsed = collapseStretchyLetters(letters);

  if (/\bkasane\s*tet[o0]+\b/i.test(lower) || collapsed.includes("kasaneteto")) {
    return { detected: true, confidence: 0.96, variant: "kasane_teto" };
  }

  if (/^t+e+t+o+$/i.test(letters) || /^t+e+o+$/i.test(letters) || /^tet[o0]{3,}$/i.test(letters)) {
    return { detected: true, confidence: 0.93, variant: "stretched_teto" };
  }

  if (collapsed === "teto" || collapsed === "tete" || /^tet[o0]+$/.test(collapsed)) {
    if (letters.length > 4) {
      return { detected: true, confidence: 0.9, variant: "stretched_teto" };
    }
  }

  if (/tetoz+inha/i.test(collapsed) || /\btetozinha\b/i.test(lower)) {
    return { detected: true, confidence: 0.88, variant: "tetozinha" };
  }

  if (/\btet[o0]{2,}\b/i.test(lower) || /\bte{2,}t[o0]+\b/i.test(lower)) {
    return { detected: true, confidence: 0.86, variant: "fuzzy_teto" };
  }

  if (/\b(teto|tete|tetozinha)\b/i.test(lower)) {
    return { detected: true, confidence: 0.8, variant: "standard" };
  }

  return { detected: false, confidence: 0, variant: null };
}

/** Mensagem curta que é só uma tentativa de chamar a Teto. */
export function isLikelyVocativeNameCall(text = "") {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > 48) return false;
  const fuzzy = detectTetoNameCall(raw);
  if (!fuzzy.detected) return false;
  if (["kasane_teto", "stretched_teto", "fuzzy_teto", "tetozinha"].includes(fuzzy.variant)) {
    return true;
  }
  const wordCount = raw.split(/\s+/).filter(Boolean).length;
  return fuzzy.variant === "standard" && wordCount <= 4;
}
