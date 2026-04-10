export function normalizeIdentityText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9?\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Só detecta intenção explícita de nome/identidade — não confundir com
 * "to sim e vc?" / "e você?" no fim (retorno de bem-estar).
 */
export function detectIdentityIntent(text) {
  const t = normalizeIdentityText(text);
  if (!t) return null;
  if (/(qual (e|é) (o )?seu nome|qual seu nome|seu nome\b|como (voce|vc) (se chama|chama))/.test(t)) {
    return { type: "name" };
  }
  const hasQuem = t.includes("quem");
  const hasVoce = t.includes("voce") || /\bvc\b/.test(t);
  if (hasQuem && hasVoce) {
    return { type: "who" };
  }
  return null;
}

/** Reservado para testes; o fluxo principal usa o modelo em vez de respostas fixas. */
export function buildIdentityReply(intent) {
  if (!intent?.type) return null;
  if (intent.type === "name") return "Sou a Teto. E você?";
  if (intent.type === "who") return "Sou a Teto.";
  return null;
}
