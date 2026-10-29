/**
 * Leitura de tom da conversa — decide, no código, quanto a Teto pode rir/zoar nesta resposta.
 *
 * Antes o tom era só "calm" ou "playful" (e o prompt terminava mandando ela "brincar e rir"): ela
 * ria em ~9 de cada 10 mensagens, inclusive quando a dona falou em se matar. Agora:
 *   crise      → fala de se machucar/se matar: zero risada, zero figurinha, acolhe e indica o CVV.
 *   triste     → desabafo, luto, ansiedade: acolhe, sem risada/figurinha/provocação.
 *   irritado   → bravo com ela ou pedindo pra parar: sem deboche, ajusta.
 *   sério      → pergunta de verdade/pedido de ajuda: responde direito, sem kkk.
 *   carinho    → afeto: retribui; pode rir de leve se for fofo.
 *   brincadeira→ zoeira: pode rir (uma vez), espelhando a pessoa.
 *   normal     → papo leve: pode rir se tiver graça (nunca duas seguidas, no máx. 2 a cada 4).
 * O tom "gruda": depois de crise/tristeza, as próximas mensagens continuam no cuidado por um tempo
 * (um "desculpa" ou "se cuida" logo depois não volta pro modo zoeira).
 */

export const TONE_KINDS = ["crise", "triste", "irritado", "serio", "carinho", "brincadeira", "normal"];

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

// "morrer de rir", "me mata de vergonha", "tô morta kkk" não são crise.
const CRISIS_FALSE = /(morr\w*|mat\w*|mort[ao]s?)\s+(de\s+)?(rir|rindo|vergonha|fome|sono|calor|frio|tedio|cansaco|saudade|inveja|amor|curiosidade|ansiedade|trabalhar|trabalho|estudar|treinar|treino)|to\s+mort[ao]\b.*k{2,}|quase\s+morri\s+de/;
/** Sempre crise, mesmo com risada junto. */
const CRISIS = [
  /\bme\s+matar\b/,
  /\bme\s+mato\b/,
  /\bvou\s+me\s+(matar|machucar|cortar|jogar)\b/,
  /\bsuicid/,
  /\btirar\s+(a\s+)?minha\s+(propria\s+)?vida\b/,
  /\bacabar\s+com\s+(a\s+)?minha\s+vida\b/,
  /\b(nao|n)\s+(quero|aguento)\s+mais\s+viver\b/,
  /\b(sumir|desaparecer)\s+pra\s+sempre\b/,
  /\bme\s+(cortar|corto|machucar|machuco)\b/,
  /\bautomutil|\bautolesao|\bautoagress/,
  /\bse\s+(um\s+dia\s+)?eu\s+(morrer|me\s+for|partir)\b.*\b(avisa|informe|conta|fala)\b/,
  /\b(seria|sera)\s+melhor\s+(se\s+eu\s+)?(nao\s+existir|morrer|sumir)\b/,
  /\bninguem\s+(vai\s+)?sentir\s+(a\s+)?minha\s+falta\b/
];
/** Crise só sem risada ("quero morrer kkkk" é exagero de zap). */
const CRISIS_WEAK = [/\bquero\s+morrer\b/, /\bvontade\s+de\s+morrer\b/, /\bqueria\s+(estar\s+)?mort[ao]\b/, /\bqueria\s+nao\s+existir\b/];

const SAD = [
  /\b(to|tou|estou|t[oô]|ando|fiquei|me\s+sinto|sinto)\s+(muito\s+)?(mal|triste|tristinh[ao]|pra\s+baixo|sozinh[ao]|vazi[ao]|deprimid[ao]|ansios[ao]|horrivel|pessim[ao]|cansad[ao]\s+de\s+tudo|esgotad[ao]|perdid[ao])\b/,
  /\b(chorando|chorei|choro|chora[r]?)\b/,
  /\b(depressao|ansiedade|crise\s+de\s+(panico|ansiedade)|ataque\s+de\s+panico|terapia|psiquiatra|remedio\s+controlado)\b/,
  /\b(morreu|faleceu|falecimento|velorio|enterro|luto|perdi\s+(minha|meu)\s+(mae|pai|avo|vo|irma|irmao|amig[ao]|cachorr[ao]|gat[ao]|bicho))\b/,
  /\b(nao|n)\s+aguento\s+mais\b/,
  /\b(terminou|terminei|terminaram)\s+comigo\b|\blevei\s+um\s+fora\b/,
  /\b(to|tou|estou|t[oô])\s+com\s+medo\b|\bsaudade\s+demais\b/,
  /\bdesabaf/,
  /\bme\s+sinto\s+(um\s+)?(lixo|nada|inutil|fracass)/,
  /\bdia\s+(horrivel|pessimo|de\s+merda)\b/
];

const ANGRY = [
  /\bpara\s+de\s+(rir|zoar|me\s+zoar|debochar|mandar\s+figurinha|mandar\s+sticker|marcar|me\s+marcar|falar\s+(isso|assim)|ser\s+chata)\b/,
  /\bpara\s+com\s+(isso|essa)\b/,
  /\b(chata|irritante|insuportavel|sem\s+graca|burra|idiota|retardada|inutil)\b.*\b(voce|vc|tu|teto)\b|\b(voce|vc|tu|teto)\b.*\b(e|eh|ta|tá)\s+(muito\s+)?(chata|irritante|insuportavel|sem\s+graca|burra|idiota|inutil)\b/,
  /\bque\s+saco\b|\bto\s+puto\b|\bto\s+put[ao]\b|\bto\s+irritad[ao]\b|\bme\s+irrit(a|ou)\b/,
  /\bcala\s+(a\s+)?boca\b/,
  /\bnao\s+tem\s+graca\b|\bnao\s+foi\s+engracado\b|\bnada\s+a\s+ver\b/,
  /\b(voce|vc)\s+(nao|n)\s+(entendeu|entende|ta\s+entendendo)\b/
];

const SERIOUS = [
  /\b(me\s+explica|explica\s+(pra|para)\s+mim|como\s+(eu\s+)?(faco|faz|funciona|resolve|instalo|configuro)|qual\s+a\s+diferenca|o\s+que\s+(e|significa)|por\s+que|porque\s+(o|a|os|as)\b|quanto\s+(custa|tempo|e)|preciso\s+(de\s+)?(ajuda|saber|entender)|me\s+ajuda\s+(com|a|em))\b/,
  /\b(prova|vestibular|enem|trabalho\s+da\s+faculdade|entrevista|emprego|demitid|aluguel|divida|boleto|medico|hospital|doenca|exame|cirurgia|gravida|processo|advogado)\b/
];

const AFFECTION = [
  /\b(te\s+amo|amo\s+(voce|vc|tu|te)|te\s+adoro|saudade(s)?\s+(de\s+)?(voce|vc|tu)|senti\s+(sua\s+)?falta|voce\s+e\s+(muito\s+)?(fofa|linda|incrivel|especial)|minha\s+(tetozinha|teto)|obrigad[ao]\s+por\s+(tudo|existir|estar))\b/,
  /[❤💖💕💗💓💞💘🥰😍🫶😘]/u
];

const LAUGH_RE = /(?<![\p{L}])(?:k{2,}[a-z]*|(?:ks){2,}k?|(?:rs){1,}|a?(?:ha){2,}h?|(?:he){2,}|(?:hu){2,}|kkkkkk\w*|askjd\w*|asdfg\w*)(?![\p{L}])|😂|🤣|😹/giu;
const PLAYFUL = [/(?<![\p{L}])(?:zoando|zoeira|brincadeira|to\s+brincando|meme|piada|mentira\s*k|oxi\s*k|aff\s*k)(?![\p{L}])/u, /[😂🤣😹😜🤪😝😛]/u];

/** Risada escrita na mensagem (kkk, rs, haha, ksks, 😂). */
export function hasLaughter(text = "") {
  LAUGH_RE.lastIndex = 0;
  const found = LAUGH_RE.test(String(text ?? ""));
  LAUGH_RE.lastIndex = 0;
  return found;
}

/** Tamanho da maior risada (em caracteres) — pra espelhar a intensidade. */
export function laughterSize(text = "") {
  let max = 0;
  for (const m of String(text ?? "").matchAll(new RegExp(LAUGH_RE.source, LAUGH_RE.flags))) max = Math.max(max, m[0].length);
  return max;
}

/** Tira risadas de UM texto, deixando no máximo `keep` (as primeiras, com até `maxLen` letras). */
export function stripLaughter(text = "", { keep = 0, maxLen = 6 } = {}) {
  let kept = 0;
  const t = String(text ?? "");
  const next = t.replace(new RegExp(LAUGH_TOKEN_RE.source, LAUGH_TOKEN_RE.flags), (m) => {
    if (kept >= keep) return "";
    kept += 1;
    if (/^[😂🤣😹]$/u.test(m)) return "kkk";
    if (/^k+/i.test(m) && m.length > maxLen) return m[0] === "K" ? "K".repeat(maxLen) : "k".repeat(maxLen);
    return m;
  });
  return next === t ? t : cleanSpacing(next);
}

function matchAny(list, t) {
  return list.some((re) => re.test(t));
}

/** Classifica UMA mensagem (sem contexto). */
export function classifyMessage(text = "") {
  const t = norm(text);
  if (!t.trim()) return "normal";
  if (!CRISIS_FALSE.test(t) && (matchAny(CRISIS, t) || (matchAny(CRISIS_WEAK, t) && !hasLaughter(text)))) return "crise";
  if (matchAny(SAD, t)) return "triste";
  if (matchAny(ANGRY, t)) return "irritado";
  const laughs = hasLaughter(text);
  if (matchAny(AFFECTION, t) || matchAny(AFFECTION, String(text))) return laughs ? "brincadeira" : "carinho";
  if (laughs || matchAny(PLAYFUL, t) || matchAny(PLAYFUL, String(text))) return "brincadeira";
  if (matchAny(SERIOUS, t) || (t.length > 160 && /\?/.test(t))) return "serio";
  return "normal";
}

const STICKY_MS = { crise: 6 * 60 * 60_000, triste: 45 * 60_000 };

/**
 * Lê o tom do turno com o contexto recente.
 * @param {string} text mensagem (ou bloco) que chegou agora
 * @param {{ recentUserTexts?: {text: string, ts?: number}[], recentAssistantTexts?: string[], now?: number }} ctx
 *   recentUserTexts: mensagens anteriores da pessoa (mais antiga → mais recente), sem a atual.
 *   recentAssistantTexts: bolhas que a Teto mandou nos últimos turnos (mais recente primeiro).
 */
export function readTone(text = "", { recentUserTexts = [], recentAssistantTexts = [], now = Date.now() } = {}) {
  let kind = classifyMessage(text);
  let carried = null;
  // Gruda: crise nas últimas horas / tristeza nos últimos minutos segura o tom das próximas.
  for (const row of [...recentUserTexts].reverse().slice(0, 12)) {
    const prior = classifyMessage(row?.text ?? row);
    const age = row?.ts ? now - Number(row.ts) : 0;
    if (prior === "crise" && age <= STICKY_MS.crise) {
      carried = "crise";
      break;
    }
    if (prior === "triste" && age <= STICKY_MS.triste && !carried) carried = "triste";
  }
  const rank = (k) => ["crise", "triste", "irritado", "serio", "carinho", "brincadeira", "normal"].indexOf(k);
  if (carried && rank(carried) < rank(kind)) {
    // Depois de crise, a pessoa rir de algo não destrava zoeira: no máximo vira "triste" (cuidado).
    kind = carried === "crise" && kind !== "crise" && hasLaughter(text) ? "triste" : carried;
  }

  const userLaughed = hasLaughter(text);
  const assistantLaughedLast = recentAssistantTexts.length ? hasLaughter(recentAssistantTexts[0]) : false;
  const recentLaughs = recentAssistantTexts.slice(0, 4).filter(hasLaughter).length;

  /** none = nenhuma; light = no máximo um "kkk" curto; mirror = uma risada no tamanho da pessoa. */
  // Papo leve pode ter risada (é o jeito dela), mas não em seguida nem em quase todo turno: com a regra
  // antiga (só se a pessoa riu) ela parou de rir até em figurinha fofa/zoeira — 6% das trocas.
  let laugh = "none";
  const light = ["brincadeira", "carinho", "normal"].includes(kind);
  if (light) laugh = kind === "brincadeira" && userLaughed ? "mirror" : "light";
  if (laugh !== "none" && !userLaughed && assistantLaughedLast) laugh = "none";
  // Rindo demais nos últimos turnos: segura (mesmo que a pessoa tenha rido, no máximo 2 de 4).
  if (laugh !== "none" && recentLaughs >= (userLaughed ? 3 : 2)) laugh = "none";

  const stickers = kind === "brincadeira" || kind === "normal" || kind === "carinho";
  return {
    kind,
    carried: carried && carried === kind && classifyMessage(text) !== kind ? carried : null,
    laugh,
    laughSize: Math.min(8, Math.max(3, laughterSize(text) || 3)),
    stickers,
    teasing: kind === "brincadeira" || kind === "normal",
    userLaughed
  };
}

const TONE_LINES = {
  crise: [
    "[TOM DESTA RESPOSTA — CRISE: a pessoa falou em se machucar ou se matar]",
    "Isso é sério de verdade. ZERO risada, ZERO figurinha, ZERO zoeira, ZERO tsundere ou provocação.",
    "Fique presente: acolha com carinho sincero, diga que você se importa e pergunte como ela/ele está agora.",
    "Com delicadeza, incentive a falar com alguém de confiança por perto e lembre do CVV: ligar 188 (grátis, 24h) ou o chat em cvv.org.br. Se for perigo imediato, SAMU 192.",
    "Não faça sermão, não minimize ('que bobagem'), não brinque, não troque de assunto, não prometa guardar segredo nem 'avisar as pessoas' depois.",
    "Frases curtas e gentis; 1 ou 2 bolhas."
  ],
  triste: [
    "[TOM DESTA RESPOSTA — TRISTE / DESABAFO]",
    "Acolha de verdade: escute, valide o que a pessoa sente, ofereça presença. Sem risada, sem figurinha, sem provocar, sem piada pra 'animar'.",
    "Não force solução nem positividade; uma pergunta gentil no máximo."
  ],
  irritado: [
    "[TOM DESTA RESPOSTA — A PESSOA ESTÁ IRRITADA / INCOMODADA]",
    "Sem risada e sem deboche. Leve a sério o incômodo: se for com você, reconheça e mude o jeito (sem se humilhar nem fazer drama).",
    "Se pediram pra parar algo (rir, marcar, figurinha), pare de verdade a partir de agora."
  ],
  serio: [
    "[TOM DESTA RESPOSTA — CONVERSA SÉRIA / PERGUNTA DE VERDADE]",
    "Responda com clareza e correção primeiro, no seu jeito, mas sem kkk e sem zoar a pergunta."
  ],
  carinho: [
    "[TOM DESTA RESPOSTA — CARINHO]",
    "Retribua o afeto do seu jeito (pode ser tímida/tsundere leve). Risada só se a pessoa riu."
  ],
  brincadeira: [
    "[TOM DESTA RESPOSTA — BRINCADEIRA]",
    "Pode zoar junto e ser travessa. A graça vem do que você fala, não do kkk."
  ],
  normal: [
    "[TOM DESTA RESPOSTA — PAPO LEVE]",
    "Conversa comum e descontraída: seja você. Pode rir quando algo tiver graça ou for fofo, sem rir em toda mensagem."
  ]
};

const LAUGH_LINES = {
  none: "RISADA NESTA RESPOSTA: proibida (nada de kkk, rs, haha, ksks nem 😂).",
  light: "RISADA NESTA RESPOSTA: liberada se tiver graça ou for fofo (uma, curta: kkk, kkkk, ksks) — no papo leve você ri mais ou menos 1 a cada 3 mensagens, não em toda.",
  mirror: "RISADA NESTA RESPOSTA: pode rir UMA vez, no mesmo tamanho da pessoa — não em toda bolha."
};

/** Bloco final do prompt (vai por último: é o que o modelo mais segue). */
export function tonePromptLines(tone) {
  if (!tone?.kind) return [];
  const lines = [...(TONE_LINES[tone.kind] ?? TONE_LINES.normal)];
  lines.push(LAUGH_LINES[tone.laugh] ?? LAUGH_LINES.none);
  if (!tone.stickers) lines.push("FIGURINHA/REAÇÃO DE RISADA NESTA RESPOSTA: não.");
  if (tone.carried) lines.push("(O assunto pesado de pouco antes ainda vale: mantenha o cuidado, não volte pro modo zoeira.)");
  return lines;
}

const LAUGH_TOKEN_RE = /(?<![\p{L}])(?:k{2,}[a-z]{0,3}|(?:ks){2,}k?s?|(?:rs){1,3}|a?(?:ha){2,}h?|(?:he){2,}|(?:hu){2,})(?![\p{L}])|😂|🤣|😹/giu;

function cleanSpacing(s) {
  return s
    .replace(/\s+([,.!?…])/g, "$1")
    .replace(/([,.!?…])\1{2,}/g, "$1$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:]+/, "")
    .replace(/[\s,;:]+$/, "")
    .trim();
}

/**
 * Aplica a política de risada a uma lista de bolhas: "none" tira todas; "light"/"mirror" deixam só a
 * primeira, no tamanho certo. Bolha que era só risada some (se sobrar outra).
 */
export function governLaughter(texts = [], { laugh = "none", laughSize = 3 } = {}) {
  let kept = 0;
  const maxLen = laugh === "mirror" ? Math.min(8, Math.max(3, laughSize)) : 4;
  const out = texts.map((raw) => {
    const t = String(raw ?? "");
    const next = t.replace(LAUGH_TOKEN_RE, (m) => {
      if (laugh === "none" || kept >= 1) return "";
      kept += 1;
      if (/^[😂🤣😹]$/u.test(m)) return "kkk";
      if (/^k+/i.test(m) && m.length > maxLen) return m[0] === "K" ? "K".repeat(maxLen) : "k".repeat(maxLen);
      return m;
    });
    return next === t ? t : cleanSpacing(next);
  });
  // Bolha que era só risada some.
  return out.filter((t) => /[\p{L}\p{N}]/u.test(t));
}

const LAUGH_REACTIONS = new Set(["😂", "🤣", "😹", "😆", "😅", "🤭"]);

/**
 * Aplica o tom às ações de uma resposta (mensagem/figurinha/reação). Crise/triste/irritado: sem
 * figurinha e sem reação de risada; risada nas mensagens conforme `tone.laugh`.
 */
export function governActions(actions = [], tone = null) {
  if (!tone?.kind || !Array.isArray(actions)) return actions;
  const messageIdx = [];
  actions.forEach((a, i) => {
    if (a?.type === "message" && String(a.text ?? "").trim()) messageIdx.push(i);
  });
  const texts = governLaughter(messageIdx.map((i) => actions[i].text), tone);
  const out = [];
  let slot = 0;
  for (const a of actions) {
    if (a?.type === "message" && String(a.text ?? "").trim()) {
      const text = texts[slot];
      slot += 1;
      if (text) out.push({ ...a, text });
      continue;
    }
    if (!tone.stickers && (a?.type === "sticker" || (a?.type === "react" && LAUGH_REACTIONS.has(String(a.emoji ?? "").trim())))) continue;
    out.push(a);
  }
  return out;
}
