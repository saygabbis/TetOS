export function slugifyStickerKey(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const STOP_WORDS = new Set([
  "a",
  "o",
  "os",
  "as",
  "de",
  "da",
  "do",
  "dos",
  "das",
  "em",
  "no",
  "na",
  "nos",
  "nas",
  "com",
  "para",
  "por",
  "um",
  "uma",
  "uns",
  "umas",
  "the",
  "and",
  "with",
  "that",
  "this",
  "sticker",
  "stickers",
  "figurinha",
  "animada",
  "animado",
  "animated",
  "imagem",
  "image",
  "gif",
  "video",
  "quadro",
  "midia",
  "mídia",
  "tonalidade",
  "predominante",
  "cor",
  "media",
  "clara",
  "escura",
  "avermelhada",
  "esverdeada",
  "azulada",
  "frames",
  "analise",
  "análise",
  "semântica",
  "semantica",
  "disponível",
  "disponivel",
  "indisponível",
  "indisponivel",
  "arquivo",
  "persistido",
  "localmente",
  "use",
  "apenas",
  "pistas",
  "básicas",
  "basicas",
  "basica",
  "básica"
]);

const SEMANTIC_PREFIX_RE = /^(sticker|imagem|image|gif|vídeo|video|mídia|midia)\b/i;

const BOILERPLATE_PATTERNS = [
  /arquivo persistido em/gi,
  /an[aá]lise sem[aâ]ntica n[aã]o ficou dispon[ií]vel/gi,
  /use apenas pistas b[aá]sicas desta m[ií]dia/gi,
  /analisada localmente/gi,
  /an[aá]lise b[aá]sica indispon[ií]vel/gi
];

/** Remove caminhos locais — nunca devem ir pro catálogo nem virar nome. */
export function stripFilePaths(text = "") {
  let s = String(text ?? "");
  s = s.replace(/[a-zA-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, " ");
  s = s.replace(/\\\\(?:[^\\\s]+\\)*[^\\\s]*/g, " ");
  s = s.replace(/(?:^|\s)\/(?:tmp|var|usr|home|Users)[^\s]*/gi, " ");
  s = s.replace(/\btetos-vision-\d+-frame\.png\b/gi, " ");
  s = s.replace(/\b[\w@~.-]*[\\/][\w@~./-]+\.(?:png|webp|jpe?g|gif|mp4|webm|mov)\b/gi, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Limpa descrições de visão antes de nomear ou persistir. */
export function sanitizeVisionDescription(description = "") {
  let s = stripFilePaths(description);
  for (const pattern of BOILERPLATE_PATTERNS) {
    s = s.replace(pattern, " ");
  }
  s = s.replace(/\s+/g, " ").replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, "").trim();
  return isUsefulVisionText(s) ? s : "";
}

/** Extrai legenda útil de descrições BLIP/PIL (ignora `C:` de paths Windows). */
export function extractVisionCaption(description = "") {
  const raw = sanitizeVisionDescription(description);
  if (!raw) return "";

  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    const prefix = raw.slice(0, colonIdx).trim();
    const tail = raw.slice(colonIdx + 1).trim();
    if (SEMANTIC_PREFIX_RE.test(prefix) && tail.length >= 3 && !looksLikePathFragment(tail)) {
      return sanitizeVisionDescription(tail);
    }
  }

  if (/^sticker/i.test(raw) && raw.includes(";")) {
    const cleaned = sanitizeVisionDescription(raw);
    return cleaned.length >= 8 ? cleaned : "";
  }

  if (looksLikePathFragment(raw)) return "";
  return raw;
}

function looksLikePathFragment(text = "") {
  const s = String(text ?? "").trim();
  if (!s) return true;
  if (/^[\\/]/.test(s)) return true;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/\btetos-vision-\d+/i.test(s)) return true;
  if (/^(users|appdata|local|temp|tmp|home)([\\/]|$)/i.test(s)) return true;
  return false;
}

function meaningfulWords(text = "") {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function isUsefulVisionText(text = "") {
  const s = String(text ?? "").trim();
  if (!s || s.length < 4) return false;
  if (looksLikePathFragment(s)) return false;
  if (/\b\d+x\d+\b/.test(s)) return true;

  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const prefix = s.slice(0, colonIdx).trim();
    const tail = s.slice(colonIdx + 1).trim();
    if (SEMANTIC_PREFIX_RE.test(prefix) && tail.length >= 3 && !looksLikePathFragment(tail)) {
      return meaningfulWords(tail).length >= 1;
    }
  }

  return meaningfulWords(s).length >= 2;
}

export function extractDisplayName(description = "", maxLen = 72) {
  const caption = extractVisionCaption(description);
  if (!caption || caption.length < 3) return null;
  return caption.slice(0, maxLen).trim();
}

/** Gera chave legível a partir da análise visual (ex.: "gato com chapéu" → gato-chapeu). */
export function deriveStickerKeyFromVision(description = "", { messageId = null, prefix = "rep" } = {}) {
  const caption = extractVisionCaption(description);
  const words = caption
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 4);

  if (words.length) {
    const key = slugifyStickerKey(words.join("-"));
    if (key && key.length >= 3) return key;
  }

  const mid = String(messageId ?? "")
    .replace(/[^0-9A-F]/gi, "")
    .slice(-8)
    .toLowerCase();
  return mid ? `${prefix}-${mid}` : `${prefix}-${Date.now()}`;
}
