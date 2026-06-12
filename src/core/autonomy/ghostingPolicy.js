const CLOSURE_PATTERNS = [
  /\b(boa noite|flw|falou|até mais|tchau|vlw)\b/i,
  /\b(vou|to|tô|indo)\s+(dormir|comer|almocar|almocar|trabalhar|estudar|descansar|sair|embora)\b/i,
  /\b(vou|to|tô)\s+sair\b/i,
  /\b(dormindo|com sono|to com sono|tô com sono|soninho|soneca)\b/i,
  /\b(da uma pausa|dá uma pausa|pausa aí|pausa ai|não me chama|nao me chama)\b/i,
  /\b(depois (eu )?falo|volto depois|mais tarde)\b/i,
  /\b(nao|não|n)\s*fala\s+(comigo|pra mim|agora)\b/i,
  /\b(to|tô|estou)\s+(doente|doenta|descansando)\b/i,
  /\bquero\s+ficar\s+so(\s|zinho|zinha|$)/i,
  /\bdeixa\s+(eu\s+)?(quieto|descansar|dormir)\b/i
];

export function detectTopicClosed(lastUserText = "") {
  return CLOSURE_PATTERNS.some((pattern) => pattern.test(String(lastUserText ?? "")));
}

export function countTrailingAssistantTurns(history = []) {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "assistant") count += 1;
    else break;
  }
  return count;
}

export function lastUserTurn(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "user") return history[i];
  }
  return null;
}

export function analyzeGhosting({ history = [], gapSinceUserMs = 0, lastUserText = "" } = {}) {
  const trailingBot = countTrailingAssistantTurns(history);
  const topicClosed = detectTopicClosed(lastUserText);
  let level = "none";

  if (trailingBot >= 1 && gapSinceUserMs > 25 * 60_000) level = "soft";
  if (trailingBot >= 2 || (trailingBot >= 1 && gapSinceUserMs > 2 * 3600_000)) level = "firm";
  if (trailingBot >= 3 || gapSinceUserMs > 12 * 3600_000) level = "heavy";

  return {
    trailingBot,
    topicClosed,
    level,
    gapSinceUserMs,
    gapSinceUserMin: Math.round(gapSinceUserMs / 60_000)
  };
}

export function shouldAllowInitiation(ghosting = {}, { mode = null, userBoundary = null } = {}) {
  const gap = ghosting.gapSinceUserMs ?? 0;
  const trailing = ghosting.trailingBot ?? 0;

  if (userBoundary?.active) {
    const level = userBoundary.level ?? "hard";
    if (level === "hard") {
      return { allow: false, reason: "user_boundary_hard" };
    }
    if (gap < 8 * 3600_000) {
      return { allow: false, reason: "user_boundary_soft" };
    }
  }

  if (ghosting.level === "heavy") {
    return { allow: false, reason: "heavy_ghosting_backoff" };
  }

  if (trailing >= 1 && gap < 50 * 60_000) {
    return { allow: false, reason: "waiting_user_reply" };
  }

  if (ghosting.level === "firm" && gap < 3 * 3600_000) {
    return { allow: false, reason: "firm_ghosting_cooldown" };
  }

  if (ghosting.topicClosed && gap < 8 * 3600_000 && !String(mode ?? "").includes("reconnect")) {
    return { allow: false, reason: "topic_closed_respect" };
  }

  if (!ghosting.topicClosed && trailing === 0 && gap < 40 * 60_000) {
    return { allow: false, reason: "too_soon_after_user" };
  }

  return { allow: true, reason: "ok" };
}

export function initiativeDeferMultiplier(ghosting = {}, mode = "") {
  let mult = 1;
  if (ghosting.topicClosed) mult *= 2.8;
  if (ghosting.level === "soft") mult *= 1.6;
  if (ghosting.level === "firm") mult *= 2.2;
  if (ghosting.level === "heavy") mult *= 4;
  if (ghosting.trailingBot >= 1) mult *= 1.8;
  if (String(mode).includes("reconnect")) mult *= 1.3;
  return mult;
}
