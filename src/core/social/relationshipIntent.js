const ACCEPT_RE =
  /\b(sim|claro|com certeza|aceito|aceita|quero sim|bora|pode ser|vamos|fechado|combinado|t[aá] dentro|eu quero)\b/i;

const LOVE_RE =
  /\b(?:eu\s+)?te\s+amo\b(?!\s+(?:como\s+)?amig[oa]s?\b)/i;

const DATE_PROPOSAL_RE =
  /\b(?:namora(?:r)?\s+comigo|(?:quer(?:es)?|vamos)\s+namorar|ser\s+(?:minha|meu)\s+(?:namorada|namorado|moz[aã]o|girl|boy)|ficar\s+comigo)\b/i;

const MARRY_PROPOSAL_RE =
  /\b(?:casa(?:r)?\s+comigo|(?:quer(?:es)?|vamos)\s+casar|casamento\s+comigo|ser\s+(?:minha|meu)\s+(?:esposa|marido|mulher|marida))\b/i;

const BREAKUP_RE =
  /\b(?:terminar|acab(?:ou|ar)|separar|n[aã]o\s+(?:quero|somos)\s+mais|desist(?:ir|o)\s+(?:do\s+)?(?:namoro|relacionamento)|a\s+gente\s+terminou)\b/i;

const FLIRT_RE =
  /\b(?:te\s+amo|namora(?:r)?|ficar\s+comigo|casa(?:r)?|beijar|casamento|sair\s+comigo|gostosa|gostoso|lind[ao]|perfeit[ao]|minha\s+(?:namorada|mulher|esposa)|meu\s+(?:namorado|marido))\b/i;

const TETO_DIRECT_RE = /\b(?:teto|tetozinha|kasane)\b/i;

export function detectAcceptance(text = "") {
  const t = String(text ?? "").trim();
  if (!t || t.length > 120) return false;
  return ACCEPT_RE.test(t);
}

export function detectLoveDeclaration(text = "") {
  return LOVE_RE.test(String(text ?? ""));
}

export function detectDatingProposal(text = "") {
  return DATE_PROPOSAL_RE.test(String(text ?? ""));
}

export function detectMarriageProposal(text = "") {
  return MARRY_PROPOSAL_RE.test(String(text ?? ""));
}

export function detectBreakupIntent(text = "") {
  return BREAKUP_RE.test(String(text ?? ""));
}

export function detectFlirtTowardTeto(text = "", { isGroup = false } = {}) {
  const t = String(text ?? "");
  if (!FLIRT_RE.test(t)) return false;
  if (TETO_DIRECT_RE.test(t)) return true;
  if (/\bcomigo\b/i.test(t)) return true;
  if (!isGroup && t.length <= 220) return true;
  return false;
}

export function relationshipStatusLabel(status = "single") {
  switch (status) {
    case "in_love":
      return "apaixonada";
    case "dating":
      return "namorando";
    case "married":
      return "casada";
    default:
      return "solteira";
  }
}

export function relationshipStatusRank(status = "single") {
  switch (status) {
    case "married":
      return 4;
    case "dating":
      return 3;
    case "in_love":
      return 2;
    default:
      return 0;
  }
}

export function inferRelationshipAdvance(text = "", { trustBond = null, isPartner = false } = {}) {
  const t = String(text ?? "");
  const intimacy = Number(trustBond?.intimacy ?? 0);
  const trust = Number(trustBond?.trust ?? 0);
  const bonded = intimacy >= 0.45 || trust >= 0.55;

  if (detectMarriageProposal(t)) {
    if (!isPartner) return null;
    return { target: "married", reason: "pedido de casamento" };
  }

  if (detectDatingProposal(t)) {
    if (bonded || detectLoveDeclaration(t) || detectAcceptance(t)) {
      return { target: "dating", reason: "pedido para namorar" };
    }
    return null;
  }

  if (detectLoveDeclaration(t) && (bonded || isPartner)) {
    return { target: "in_love", reason: "declaração de amor" };
  }

  return null;
}
