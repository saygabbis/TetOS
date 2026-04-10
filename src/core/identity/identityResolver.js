export function normalizeIdentityText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9?\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectIdentityIntent(text) {
  const t = normalizeIdentityText(text);
  if (!t) return null;
  if (/(qual (e|é) (o )?seu nome|qual seu nome|seu nome\b|como (voce|vc) (se chama|chama))/.test(t)) {
    return { type: "name" };
  }
  const hasQuem = t.includes("quem");
  const hasVoce = t.includes("voce") || t.includes("vc");
  if ((hasQuem && hasVoce) || /\be\s+voce\b/.test(t) || /\be (voce|vc)\??\s*$/.test(t)) {
    return { type: "who" };
  }
  return null;
}

export function buildIdentityReply(intent) {
  if (!intent?.type) return null;
  if (intent.type === "name") return "Sou a Teto. E você?";
  if (intent.type === "who") return "Sou a Teto.";
  return null;
}
