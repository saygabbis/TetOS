const NAMED_COLORS = {
  verde: "#00B140",
  green: "#00B140",
  chroma: "#00B140",
  chromakey: "#00B140",
  azul: "#0000FF",
  blue: "#0000FF",
  vermelho: "#FF0000",
  red: "#FF0000",
  branco: "#FFFFFF",
  white: "#FFFFFF",
  preto: "#000000",
  black: "#000000",
  rosa: "#FF69B4",
  pink: "#FF69B4",
  amarelo: "#FFFF00",
  yellow: "#FFFF00"
};

/** Potência: leve=local small; media/forte=API remove.bg (forte tenta full→auto); fallback local medium (imgly não tem large) */
const MODEL_ALIASES = {
  small: "small",
  leve: "small",
  fraca: "small",
  fraco: "small",
  rapido: "small",
  rápido: "small",
  fast: "small",
  "1": "small",
  medium: "medium",
  media: "medium",
  medio: "medium",
  médio: "medium",
  normal: "medium",
  "2": "medium",
  large: "large",
  forte: "large",
  max: "large",
  potente: "large",
  lento: "large",
  slow: "large",
  hq: "large",
  alta: "large",
  "3": "large"
};

export const REMOVE_BG_MODEL_LABELS = {
  small: "leve",
  medium: "media",
  large: "forte"
};

export function normalizeRemoveBgModel(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const key = String(raw).trim().toLowerCase();
  return MODEL_ALIASES[key] ?? null;
}

function parseBackgroundArg(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { background: null };
  }

  const trimmed = String(raw).trim();
  const lower = trimmed.toLowerCase();

  if (["transparente", "transparent", "alpha", "trans"].includes(lower)) {
    return { background: null };
  }

  if (NAMED_COLORS[lower]) {
    return { background: NAMED_COLORS[lower] };
  }

  if (/^#[0-9a-f]{3}$/i.test(trimmed) || /^#[0-9a-f]{6}$/i.test(trimmed) || /^#[0-9a-f]{8}$/i.test(trimmed)) {
    return { background: normalizeHex(trimmed) };
  }

  return {
    error: `Argumento invalido: "${trimmed}". Cor: verde, #00ff00. Potencia: leve, media, forte.`
  };
}

/**
 * @param {string[]} args — cor e/ou potência em qualquer ordem
 * @returns {{ background?: string|null, model?: string, error?: string }}
 * model omitido = usar TETOS_REMOVEBG_MODEL do .env
 */
export function resolveRemoveBgOptions(args = []) {
  let background = null;
  let backgroundSet = false;
  let model;

  for (const raw of args ?? []) {
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;

    const modelHit = normalizeRemoveBgModel(raw);
    if (modelHit) {
      model = modelHit;
      continue;
    }

    const colorResult = parseBackgroundArg(raw);
    if (colorResult.error) return colorResult;
    background = colorResult.background;
    backgroundSet = true;
  }

  if (!backgroundSet && (!args || args.length === 0)) {
    background = null;
  }

  return { background, model };
}

function normalizeHex(hex) {
  const h = hex.replace(/^#/, "");
  if (h.length === 3) {
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toUpperCase();
  }
  return `#${h.slice(0, 6)}`.toUpperCase();
}

/** @param {string} hex */
export function parseHexColor(hex) {
  const h = hex.replace(/^#/, "");
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16)
    };
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}
