import { maxConsecutiveKRun } from "./extractor.js";

const EXPRESSION_PATTERNS = [
  /\b(oxi+|oxeee+|aff+|mds|slc|sla|tipo|véi|vei|mano|cara|meu|po|pô|né+n?h?|tlgd|tlg|tmj|vdd|blz|flw|vlw|bora|sério|serio|affs|pqp|carai|cacete|porra|tá|ta|to|tô)\b/gi,
  /\b(ora|ih|ui|eba+|uau+|nossa+|poxa+|puts+|aff)\b/gi
];

function topNRecord(record = {}, limit = 20) {
  return Object.fromEntries(
    Object.entries(record)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
  );
}

export function harvestExpressions(message, max = 12) {
  const text = String(message ?? "");
  const found = new Map();
  for (const pattern of EXPRESSION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const word = String(match[1] ?? "").toLowerCase();
      if (!word || word.length < 2) continue;
      found.set(word, (found.get(word) ?? 0) + 1);
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
}

export function detectLaughterMode(message) {
  const text = String(message ?? "");
  const hasK = /k{2,}/i.test(text);
  const hasRs = /\brs+\b/i.test(text);
  const hasHa = /(ha){2,}|(he){2,}|(hi){2,}|hahaha+/i.test(text);
  const hasEmoji = /[\u{1F600}-\u{1F64F}\u{1F923}\u{1F602}\u{1F605}]/u.test(text);
  const modes = [];
  if (hasK) modes.push("kk");
  if (hasRs) modes.push("rs");
  if (hasHa) modes.push("ha");
  if (hasEmoji) modes.push("emoji");
  if (!modes.length) return null;
  if (modes.length === 1) return modes[0];
  return "mixed";
}

function pickPreferredLaughter(counts = {}) {
  const ranked = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "kk";
  const top = ranked[0][0];
  if (top === "emoji" && (counts.kk ?? 0) > 0) return "kk";
  return top;
}

export function updateLearnedStyle(profileStyle = {}, message = "") {
  const text = String(message ?? "").trim();
  if (!text) return { ...profileStyle };

  const style = { ...profileStyle };
  const learned = { ...(style.learned ?? {}) };

  const exprMap = { ...(learned.expressions ?? {}) };
  for (const [word, count] of harvestExpressions(text)) {
    exprMap[word] = (exprMap[word] ?? 0) + count;
  }
  learned.expressions = topNRecord(exprMap, 24);

  const laughCounts = { kk: 0, rs: 0, ha: 0, emoji: 0, ...(learned.laughterModes ?? {}) };
  const mode = detectLaughterMode(text);
  if (mode === "mixed") {
    if (/k{2,}/i.test(text)) laughCounts.kk += 1;
    if (/\brs+\b/i.test(text)) laughCounts.rs += 1;
    if (/(ha){2,}|(he){2,}|hahaha+/i.test(text)) laughCounts.ha += 1;
    if (/[\u{1F602}\u{1F923}\u{1F605}]/u.test(text)) laughCounts.emoji += 1;
  } else if (mode) {
    laughCounts[mode] = (laughCounts[mode] ?? 0) + 1;
  }
  learned.laughterModes = laughCounts;
  learned.preferredLaughter = pickPreferredLaughter(laughCounts);

  const lower = text.toLowerCase();
  const habits = { ...(learned.habits ?? {}) };
  if (/\bné\b|\bnéh\b/i.test(lower)) habits.usesNe = (habits.usesNe ?? 0) + 1;
  if (/\b(vc|pq|tb|msm|q|n|blz|flw|vlw)\b/.test(lower)) habits.usesAbbrev = (habits.usesAbbrev ?? 0) + 1;
  if (/[aeiouáéíóúâêôãõ]\1{2,}/i.test(text)) habits.stretchesVowels = (habits.stretchesVowels ?? 0) + 1;
  if (/[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{4,}/.test(text)) habits.usesCaps = (habits.usesCaps ?? 0) + 1;
  learned.habits = habits;

  learned.avgKkRun = Math.round(
    ((learned.avgKkRun ?? 0) * 0.7 + maxConsecutiveKRun(text) * 0.3) * 10
  ) / 10;

  style.learned = learned;
  return style;
}

export function formatLearnedStyleForPrompt(learned = {}, stylePrefs = {}, liveHints = {}) {
  const lines = [];
  const topExpr = Object.keys(learned.expressions ?? {}).slice(0, 10);
  if (topExpr.length) {
    lines.push(`- VOCABULÁRIO ADOTADO: Esta pessoa costuma falar usando: ${topExpr.join(", ")}. Você pode adotar essas mesmas gírias de forma natural.`);
  }

  const pref =
    liveHints.preferredLaughter ??
    learned.preferredLaughter ??
    (stylePrefs.prefersLaughter ? "kk" : null);
  const kkRun = Math.max(liveHints.userKkMaxRun ?? 0, learned.avgKkRun ?? 0);

  if (pref === "kk" || stylePrefs.prefersLaughter || kkRun >= 3) {
    const sample = kkRun >= 10 ? "kkkkkkk" : kkRun >= 6 ? "kkkkk" : "kkk";
    lines.push(
      `- RISADA DO USUÁRIO: Ele costuma rir usando teclado (${sample}, ksks). Espelhe esse padrão (use 'kkk' e similares por texto, nunca 😂/🤣).`
    );
  } else if (pref === "rs") {
    lines.push("- RISADA DO USUÁRIO: Ele costuma usar 'rs' / 'rsrs'. Se for rir junto, prefira responder com 'rs'.");
  } else if (pref === "emoji" || stylePrefs.prefersEmoji) {
    lines.push("- PREFERÊNCIA DE EMOJI: Ele usa bastante emojis. Pode usá-los nas suas mensagens, mas dê preferência a risadas por texto.");
  }

  const habits = learned.habits ?? {};
  if (habits.usesNe >= 2) lines.push('- VÍCIO DE LINGUAGEM: O usuário finaliza frases com "né". Você pode incluir "né" em suas falas pontualmente.');
  if (habits.usesAbbrev >= 3) lines.push("- ABREVIAÇÕES: Ele digita de forma abreviada (vc, pq, tb). Espelhe esse ritmo sem forçar termos que você não costuma usar.");
  if (habits.stretchesVowels >= 2) lines.push("- VOGAIS ESTICADAS: Ele alonga palavras (ex: 'oooi', 'ebaaa'). Sinta-se livre para espelhar essa expressividade física.");
  if (habits.usesCaps >= 2) lines.push("- CAIXA ALTA: Ele usa CAPS LOCK para expressar ênfase ou gritos. Você pode subir o volume (digitar palavras em CAPS) seguindo a vibe dele.");

  if (stylePrefs.brevity === "short") lines.push("- COMPRIMENTO: O usuário envia mensagens curtas e diretas. Responda de forma concisa e sem enrolação.");
  if (stylePrefs.prefersLaughter) lines.push("- INTERAÇÃO DESCONTRAÍDA: Ele é brincalhão no chat. Adote uma postura mais leve, travessa e brincalhona.");

  return lines;
}
