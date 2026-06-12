function normalize(text = "") {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HARD_BOUNDARY = [
  /\b(nao|n)\s*fala\s+(comigo|pra mim|com a gente|agora)\b/,
  /\b(nao|n)\s*me\s*(chama|perturb|atrapalh|encher)\b/,
  /\bdeixa\s+(eu\s+)?(quieto|quietinha|descansar|dormir|so|sozinho|sozinha)\b/,
  /\bquero\s+(ficar|fica)\s+so(\s|zinho|zinha|$)/,
  /\b(to|tô|estou)\s+(doente|doenta|mal|pessima|péssima|enjoad)/,
  /\b(to|tô|estou)\s+descansando\b/,
  /\bnao\s+quero\s+convers/,
  /\bdeixa\s+pra\s+depois\b/,
  /\bpor\s+agora\s+nao\b/,
  /\bnao\s+fala\s+comigo\b/,
  /\bpreciso\s+(descansar|dormir|ficar\s+so)/,
  /\bme\s+deixa\s+(em\s+)?paz\b/,
  /\bsem\s+papo\s+agora\b/
];

const SOFT_BOUNDARY = [
  /\b(to|tô|estou)\s+com\s+sono\b/,
  /\b(to|tô|estou)\s+cansad/,
  /\bvou\s+dormir\b/,
  /\b(to|tô|estou)\s+ocupad/,
  /\bindo\s+dormir\b/,
  /\bboa\s+noite\b/
];

/** Usuário pediu espaço, descanso ou não ser incomodado. */
export function detectUserBoundary(text = "") {
  const raw = String(text ?? "").trim();
  const t = normalize(raw);
  if (!t) return { level: "none", reason: null, durationMs: null };

  if (HARD_BOUNDARY.some((re) => re.test(t))) {
    return { level: "hard", reason: "user_requested_space", durationMs: 14 * 3600_000 };
  }
  if (SOFT_BOUNDARY.some((re) => re.test(t))) {
    return { level: "soft", reason: "user_winding_down", durationMs: 6 * 3600_000 };
  }
  return { level: "none", reason: null, durationMs: null };
}

export function isUserBoundaryActive(profile = null, now = Date.now()) {
  const until = profile?.facts?.userBoundaryUntil ?? null;
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now;
}

export function userBoundarySnapshot(profile = null, now = Date.now()) {
  const active = isUserBoundaryActive(profile, now);
  return {
    active,
    until: active ? profile?.facts?.userBoundaryUntil : null,
    reason: active ? profile?.facts?.userBoundaryReason ?? null : null,
    level: active ? profile?.facts?.userBoundaryLevel ?? "hard" : "none"
  };
}

export function applyUserBoundary(profileUpdate = {}, text = "", now = Date.now()) {
  const detected = detectUserBoundary(text);
  if (detected.level === "none") return null;
  const until = new Date(now + detected.durationMs).toISOString();
  return {
    userBoundaryUntil: until,
    userBoundaryReason: detected.reason,
    userBoundaryLevel: detected.level,
    userBoundarySetAt: new Date(now).toISOString()
  };
}

/** Mensagem curta que reabre o papo depois de um período de espaço. */
export function isBoundaryReopening(text = "") {
  const raw = String(text ?? "").trim();
  const t = normalize(raw);
  if (!t || t.length > 80) return false;
  if (detectUserBoundary(text).level !== "none") return false;
  return (
    /^(oi+|oie+|ola+|eae+|hey+|fala|e\s*ai)\b/.test(t) ||
    /\b(voltei|to de volta|pode falar|pode vir|to melhor)\b/.test(t)
  );
}

export function clearUserBoundaryFacts(facts = {}) {
  return {
    ...facts,
    userBoundaryUntil: null,
    userBoundaryReason: null,
    userBoundaryLevel: null,
    userBoundarySetAt: null
  };
}
