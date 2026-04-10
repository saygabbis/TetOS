/**
 * Reações na mensagem do usuário (1 emoji por reação no WhatsApp).
 * Esparso + cooldown — o orchestrador incrementa `messagesSinceLastReaction` a cada turno.
 */

const COOLDOWN_MS = 3.5 * 60 * 1000;
const MIN_MESSAGES_BETWEEN = 6;
const BASE_MATCH_CHANCE = 0.28;

const E = {
  heart: "❤️",
  kiss: "😘",
  pray: "🙏",
  joy: "😂",
  fire: "🔥",
  sparkle: "✨",
  thumbs: "👍"
};

function pickEmojiForText(t) {
  const lastLine = String(t ?? "")
    .trim()
    .split("\n")
    .pop()
    .trim()
    .toLowerCase();

  if (/^(beijos?|bjos|bj|muah|xuxu)([!.?…]*)?$/i.test(lastLine)) {
    return Math.random() < 0.45 ? E.kiss : E.heart;
  }
  if (/\b(obrigad|brigad|valeu demais|vlw demais)\b/i.test(t) && lastLine.length < 56) {
    return Math.random() < 0.5 ? E.pray : E.sparkle;
  }
  if (/\b(valeu|vlw|fechou|show)\b/i.test(lastLine) && lastLine.length < 28) {
    return E.thumbs;
  }
  if (/k{4,}|kkkk|ksks/i.test(t) && lastLine.length < 40) {
    return Math.random() < 0.35 ? E.joy : null;
  }
  if (/❤️|💕|💗/.test(t)) {
    return Math.random() < 0.4 ? E.heart : E.sparkle;
  }
  if (/\b(arrasou|mitou|lindo demais|perfeito)\b/i.test(t) && lastLine.length < 48) {
    return Math.random() < 0.4 ? E.fire : E.sparkle;
  }
  return null;
}

/**
 * @param {{ userText: string, state: { messagesSinceLastReaction?: number, lastReactionAt?: number } }}
 * @returns {{ emoji: string | null }}
 */
export function planWhatsAppReaction({ userText, state = {} }) {
  const now = Date.now();
  const since = Number(state.messagesSinceLastReaction ?? 0);
  const lastAt = Number(state.lastReactionAt ?? 0);

  if (since < MIN_MESSAGES_BETWEEN) {
    return { emoji: null };
  }
  if (lastAt && now - lastAt < COOLDOWN_MS) {
    return { emoji: null };
  }

  const emoji = pickEmojiForText(userText);
  if (!emoji || Math.random() > BASE_MATCH_CHANCE) {
    return { emoji: null };
  }

  return { emoji };
}
