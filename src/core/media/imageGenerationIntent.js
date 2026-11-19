const IMAGE_GEN_RE =
  /\b(?:gera|gere|gerar|cria|crie|criar|desenha|desenhe|desenhar|faz|faça|fazer|manda|monta|produz)\s+(?:(?:pra|para)\s+mim\s+|me\s+)?(?:uma?\s+)?(?:imagem|figura|arte|desenho|foto|ilustra[cç][aã]o|pintura|fanart|wallpaper|picture|image)\b/i;

const IMAGE_GEN_OF_RE =
  /\b(?:imagem|arte|desenho|foto|ilustra[cç][aã]o|pintura|fanart|wallpaper)\s+(?:de|do|da|dos|das|com)\s+(.+)/i;

/** "desenha um gato de chapéu" (sem a palavra imagem). */
const DRAW_RE = /\b(?:desenha|desenhe|ilustra|pinta)\s+(?:(?:pra|para)\s+mim\s+|me\s+)?(.{3,})/i;

/** Verbo de CRIAR (não "manda uma foto") e não é foto dela: dá pra gerar mesmo se o modelo esquecer. */
const STRONG_RE =
  /\b(?:gera|gere|gerar|cria|crie|criar|desenha|desenhe|desenhar|ilustra|pinta)\b|\b(?:faz|fa[cç]a|fazer)\s+(?:(?:pra|para)\s+mim\s+|me\s+)?(?:uma?\s+)?(?:desenho|imagem|arte|ilustra|pintura|fanart|wallpaper)/i;
const SELF_PHOTO_RE = /\b(?:sua|seu|tua|teu|de voc[eê]|selfie)\b/i;

function isStrong(text) {
  return STRONG_RE.test(text) && !SELF_PHOTO_RE.test(text);
}

function promptFrom(text) {
  const ofMatch = text.match(IMAGE_GEN_OF_RE);
  const fromOf = ofMatch?.[1]?.trim();
  const fromReplace = text.replace(IMAGE_GEN_RE, "").trim();
  return (fromOf || fromReplace || text).replace(/[?!.]+$/, "").trim();
}

/**
 * Pedido de gerar imagem na conversa. `strong` = pedido claro de criar (gera/cria/desenha), que
 * vira geração mesmo se o modelo só responder "vou fazer!" sem chamar gerarImagem.
 */
export function detectImageGenerationIntent(text = "") {
  const raw = String(text ?? "").trim();
  if (!raw || raw.startsWith(".")) return null;
  const body = raw.replace(/^(?:teto|tetos|tetozinha|hey teto|ei teto)[,\s]+/i, "");

  if (IMAGE_GEN_RE.test(body)) {
    const prompt = promptFrom(body);
    if (prompt.length >= 3) return { prompt, source: "natural", strong: isStrong(body) };
  }

  const draw = body.match(DRAW_RE);
  if (draw && !SELF_PHOTO_RE.test(body)) {
    const prompt = draw[1].replace(/[?!.]+$/, "").trim();
    if (prompt.length >= 3) return { prompt, source: "natural", strong: true };
  }

  return null;
}

/** Pediu caprichado ("em alta qualidade", "hd", "no modelo bom", "ultra", "4k")? */
const HD_IMAGE_SRC =
  "(?:\\b(?:em|no|com)\\s+)?(?:\\balta\\s+(?:qualidade|resolu[cç][aã]o|defini[cç][aã]o)|\\b(?:full\\s*)?hd\\b(?!\\s+(?:externo|interno|ssd))|\\bultra(?:\\s*hd)?\\b|\\b[248]k\\b|\\bmodelo\\s+(?:bom|melhor|caro|top)\\b|\\bbem\\s+(?:detalhad[ao]|caprichad[ao])|\\bcaprichad[ao]\\b|\\bqualidade\\s+m[aá]xima)";
const HD_IMAGE_TEST = new RegExp(HD_IMAGE_SRC, "i");
const HD_IMAGE_ALL = new RegExp(HD_IMAGE_SRC, "gi");

export function wantsHdImage(text = "") {
  return HD_IMAGE_TEST.test(String(text ?? ""));
}

/** Tira as palavras de "caprichado" da descrição (viram opção do modo bom). */
export function stripHdWords(text = "") {
  return String(text ?? "").replace(HD_IMAGE_ALL, " ").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
}
