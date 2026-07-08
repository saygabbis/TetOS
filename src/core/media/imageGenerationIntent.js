const IMAGE_GEN_RE =
  /\b(?:gera|gerar|cria|criar|desenha|desenhar|faz|faça|fazer|manda|monta|produz)\s+(?:uma?\s+)?(?:imagem|figura|arte|desenho|foto|picture|image)\b/i;

const IMAGE_GEN_OF_RE =
  /\b(?:imagem|arte|desenho|foto)\s+(?:de|do|da|com)\s+(.+)/i;

export function detectImageGenerationIntent(text = "") {
  const raw = String(text ?? "").trim();
  if (!raw || raw.startsWith(".")) return null;

  if (IMAGE_GEN_RE.test(raw)) {
    const ofMatch = raw.match(IMAGE_GEN_OF_RE);
    const fromOf = ofMatch?.[1]?.trim();
    const fromReplace = raw.replace(IMAGE_GEN_RE, "").trim();
    const prompt = (fromOf || fromReplace || raw).trim();
    if (prompt.length >= 3) return { prompt, source: "natural" };
  }

  const tetoPrefix =
    /^(?:teto|tetos|tetozinha|hey teto|ei teto)[,\s]+(.+)/i.exec(raw);
  if (tetoPrefix) {
    const rest = tetoPrefix[1];
    if (IMAGE_GEN_RE.test(rest) || IMAGE_GEN_OF_RE.test(rest)) {
      const ofMatch = rest.match(IMAGE_GEN_OF_RE);
      const prompt = (ofMatch?.[1] ?? rest).replace(IMAGE_GEN_RE, "").trim();
      if (prompt.length >= 3) return { prompt, source: "natural" };
    }
  }

  return null;
}
