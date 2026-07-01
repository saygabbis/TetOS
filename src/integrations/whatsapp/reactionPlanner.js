import { DEFAULTS } from "../../infra/config/defaults.js";
import { RESPONSE_MODES } from "../../core/pipeline/responseModes.js";

/**
 * Reações na mensagem do usuário (1 emoji por reação no WhatsApp).
 * Usa afinidades aprendidas do MediaLearningHub quando disponível.
 */

/** @deprecated use planStickerOnly from reactionPlanner — integrado do antigo stickerPlanner */
export function planStickerOnly({ policy, isGroup = false, hasMedia = false } = {}) {
  if (!isGroup) return { useSticker: false };
  if (hasMedia) return { useSticker: false };
  if (policy?.mode === RESPONSE_MODES.REACT_ONLY && Math.random() < DEFAULTS.stickerOnlyChance) {
    return { useSticker: true, stickerKey: "ack" };
  }
  return { useSticker: false };
}

const COOLDOWN_MS = 3.5 * 60 * 1000;
const MIN_MESSAGES_BETWEEN = 6;
const BASE_MATCH_CHANCE = 0.35;

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
  if (/(^|\b)(flw|falou|tchau|xau|até|ate|ok|okey|blz|beleza|valeu|vlw)(\b|$)/i.test(lastLine) && lastLine.length < 24) {
    return Math.random() < 0.65 ? E.heart : E.thumbs;
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
 * @param {{ userText: string, state: { messagesSinceLastReaction?: number, lastReactionAt?: number }, affinities?: { topReactions?: { emoji: string, count: number }[] } }}
 * @returns {{ emoji: string | null }}
 */
export function planWhatsAppReaction({ userText, state = {}, affinities = null }) {
  const now = Date.now();
  const since = Number(state.messagesSinceLastReaction ?? 0);
  const lastAt = Number(state.lastReactionAt ?? 0);

  if (since < MIN_MESSAGES_BETWEEN) {
    return { emoji: null };
  }
  if (lastAt && now - lastAt < COOLDOWN_MS) {
    return { emoji: null };
  }

  let emoji = pickEmojiForText(userText);
  const learned = affinities?.topReactions?.[0]?.emoji;
  if (!emoji && learned && Math.random() < 0.22) {
    emoji = learned;
  }
  if (!emoji || Math.random() > BASE_MATCH_CHANCE) {
    return { emoji: null };
  }

  return { emoji };
}
