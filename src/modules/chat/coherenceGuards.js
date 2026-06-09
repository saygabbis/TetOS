/** Detecta mensagem curta dirigida à Teto (vocativo/afeto). */
export function isVocativeToTeto(text = "") {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || t.length > 48) return false;
  return /^(amiga|amigo|amor|mana|mano|moz[aã]o|querida|querido|bb|beb[eê]|vida|amorzinho|linda|lindo|gata|gato|tetozinha|minha tetozinha|sumida|sumido)[!.?…\s]*$/i.test(
    t
  );
}

/** Frase/bolha cortada no meio — sem fechamento de ideia. */
export function isIncompleteBubble(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return true;

  const words = t.split(/\s+/).filter(Boolean);

  if (/^(não que|nao que)\b/i.test(t)) {
    if (words.length <= 4) return true;
    if (/\bestivesse\b/i.test(t) && !/\bestivesse\s+\w{3,}/i.test(t)) return true;
  }
  if (/^(como se|se eu|que eu|tipo que|sem que|antes que)\b/i.test(t) && words.length <= 6) {
    return true;
  }
  if (words.length >= 2 && words.length <= 5) {
    const last = words[words.length - 1].toLowerCase().replace(/[.!?…]+$/, "");
    const dangling = new Set([
      "estivesse",
      "fosse",
      "tivesse",
      "pudesse",
      "quisesse",
      "sendo",
      "estar",
      "ter",
      "que",
      "se",
      "mas",
      "porque",
      "pra",
      "sem",
      "com",
      "de",
      "do",
      "da",
      "no",
      "na",
      "um",
      "uma",
      "eu",
      "você",
      "voce"
    ]);
    if (dangling.has(last) && !/[.!?…]$/.test(t)) return true;
  }

  if (/^(mas|e|ou|se|porque|pra|então|tipo)\b/i.test(t) && t.length < 28 && !/[.!?…*]$/.test(t)) {
    return true;
  }
  if (/^que\s/i.test(t) && t.length < 28 && !/[.!?…*]$/.test(t)) {
    if (/^que\s+(é|foi|ser|era|seria|acontece|importa|dizer|tal|eu|você|voce|a gente)\b/i.test(t)) {
      return true;
    }
    if (/^que\s+[a-záéíóúàâêôãõç]{3,}/i.test(t)) {
      return false;
    }
    return true;
  }

  return false;
}

/** "Oi, Nome!" no meio do papo ou quando o usuário não cumprimentou. */
export function isMisplacedOpeningGreeting(text = "", userMessage = "", { hasHistory = false } = {}) {
  const a = String(text ?? "").trim();
  const u = String(userMessage ?? "").trim().toLowerCase();
  if (!/^oi+e?,?\s+/i.test(a)) return false;
  if (/^(oi+|oie+|eae+|hey+|ol[aá])/i.test(u)) return false;
  if (isVocativeToTeto(u)) return true;
  if (hasHistory) return true;
  return false;
}

export function hasCoherenceIssues(parts = [], userMessage = "", { hasHistory = false } = {}) {
  const list = Array.isArray(parts) ? parts : [parts];
  if (!list.length) return true;
  if (list.some((p) => isIncompleteBubble(p))) return true;
  if (list[0] && isMisplacedOpeningGreeting(list[0], userMessage, { hasHistory })) return true;
  return false;
}

/** Junta bolhas quebradas ou remove fragmento sem sentido. */
export function repairBubbleCoherence(parts = []) {
  const list = (Array.isArray(parts) ? parts : []).map((p) => String(p ?? "").trim()).filter(Boolean);
  if (list.length <= 1) return list;

  const repaired = [];
  for (let i = 0; i < list.length; i += 1) {
    const cur = list[i];
    if (!isIncompleteBubble(cur)) {
      repaired.push(cur);
      continue;
    }
    const next = list[i + 1];
    if (next) {
      repaired.push(`${cur} ${next}`.trim());
      i += 1;
      continue;
    }
    const prev = repaired[repaired.length - 1];
    if (prev && !isIncompleteBubble(prev)) {
      repaired[repaired.length - 1] = `${prev} ${cur}`.trim();
    }
  }

  return repaired.filter((p) => p && !isIncompleteBubble(p));
}

/** Pontuação de zap informal — Teto gremlin, sem vírgula/ponto pendurado. */
export function normalizeInformalEnding(text = "") {
  let t = String(text ?? "").trim();
  if (!t) return t;

  t = t.replace(/[,;]+\s*$/, "");
  t = t.replace(/\s+([!?.,…])/g, "$1");

  if (/\.\s*$/.test(t) && !/\?$/.test(t) && !/!$/.test(t) && t.length > 8) {
    t = t.replace(/\.\s*$/, "");
  }

  return t.trim();
}

/** "to com fome amiga" — vocativo no fim também conta. */
export function hasVocativeToTeto(text = "") {
  if (isVocativeToTeto(text)) return true;
  const t = String(text ?? "").trim().toLowerCase();
  return /\b(amiga|amigo|tetozinha|moz[aã]o|querida|querido)\s*[!.?…]*$/i.test(t);
}

/** "EU QUERO", "nossa por favor" — empolgação curta com contexto no quote/histórico. */
export function isShortEnthusiasticReply(userMessage = "", quotedMessage = null, history = []) {
  const u = String(userMessage ?? "").trim();
  if (!u || u.length > 56) return false;

  const hasQuote = Boolean(String(quotedMessage ?? "").trim());
  const rows = Array.isArray(history) ? history : [];
  const lastAssistant = [...rows].reverse().find((m) => m?.role === "assistant");
  const hasThread = Boolean(lastAssistant?.content?.trim());

  if (!hasQuote && !hasThread) return false;

  const lettersOnly = u.replace(/[^a-záàâãéêíóôõúçA-Z]/gi, "").toLowerCase();
  if (/^(eu)+quero$/i.test(lettersOnly) || /^quero$/i.test(lettersOnly)) return true;
  if (/^(eu\s*)+(quero|QUERO|quero+)[!.?\s]*$/i.test(u)) return true;
  if (u.length <= 48 && /\bquero\b/i.test(u) && !/\b(n[aã]o|nem)\s+quero\b/i.test(u)) return true;
  if (/^(nossa\s+)?(por favor|pfv|pls|sim+|fecha|fechou|bora|vamos)[!.?\s]*$/i.test(u)) return true;
  if (u.length <= 28 && /\b(quero|adoro|muito|demais|pf|por favor)\b/i.test(u)) return true;

  return false;
}

/** Resposta que ignora quote/contexto óbvio. */
export function isContextBlindReply(parts = [], userMessage = "", meta = {}) {
  const combined = (Array.isArray(parts) ? parts : [parts]).join(" ").toLowerCase();
  if (!combined) return false;
  const u = String(userMessage ?? "").trim();
  const hasQuote = Boolean(meta?.quotedMessage || meta?.quotedMessageId);
  const shortUser = u.length < 56;

  if (!shortUser && !hasQuote) return false;

  return (
    /\b(t[aá] afim de alguma coisa|quer dizer que t[aá] afim|manda logo|o que (cê|você) quer)\b/i.test(
      combined
    ) && (hasQuote || isShortEnthusiasticReply(u, meta?.quotedMessage, meta?.recentHistory))
  );
}

/**
 * Reação curta ao que a Teto disse (ex.: "oia que safada" depois de provocação dela).
 * Sem quote — usa última msg assistant no histórico.
 */
export function isReactionDirectedAtAssistant(userMessage = "", history = []) {
  const u = String(userMessage ?? "").trim();
  if (!u || u.length > 80) return false;

  const rows = Array.isArray(history) ? history : [];
  const lastAssistant = [...rows].reverse().find((m) => m?.role === "assistant" && String(m?.content ?? "").trim());
  if (!lastAssistant) return false;

  const reactToSelf =
    /\b(safad[oa]s?|sem vergonha|ousad[oa]|atrevid[oa]|malandr[oa]|tarad[oa]|pervertid[oa])\b/i.test(u) ||
    /\b(oia|olha|nossa|mds|aff|oxi)\b.*\b(safad|sem vergonha|ousad)/i.test(u) ||
    /^(oia|olha|nossa|mds|aff|oxi)\s*(que\s+)?(safad|sem vergonha)/i.test(u);

  if (!reactToSelf) return false;

  const assistantText = String(lastAssistant.content ?? "");
  return assistantText.length > 8;
}

/** Mensagem curta do usuário → prefira 1 bolha coesa (só micro-respostas, não pensamentos distintos). */
export function collapseForShortUserPrompt(parts = [], userMessage = "") {
  const u = String(userMessage ?? "").trim();
  const list = Array.isArray(parts) ? parts.filter(Boolean) : [];
  if (list.length <= 1) return list.map(normalizeInformalEnding);
  if (u.length > 32 && u.includes("?")) return list.map(normalizeInformalEnding);

  const totalAssistant = list.join(" ").replace(/\s+/g, " ").length;
  const hasDistinctThoughts = list.length >= 2 && list.some((p) => String(p).split(/\s+/).filter(Boolean).length >= 4);
  if (hasDistinctThoughts) return list.map(normalizeInformalEnding);

  const microOnly = list.every((p) => {
    const words = String(p).split(/\s+/).filter(Boolean).length;
    return words <= 6 && String(p).length <= 48;
  });
  if (!microOnly) return list.map(normalizeInformalEnding);

  if (hasVocativeToTeto(u) || u.length <= 22) {
    const joined = normalizeInformalEnding(list.join(" ").replace(/\s+/g, " "));
    if (joined.length <= 280 && totalAssistant <= 120) return [joined];
  }
  return list.map(normalizeInformalEnding);
}
