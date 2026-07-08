/** Detecta pedido natural de comando de mídia em reply a uma mensagem com mídia. */
export function detectAgentMediaReplyIntent(text = "", meta = {}) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.startsWith(".")) return null;

  const quotedId = String(meta?.quotedMessageId ?? "").trim();
  const isReply = Boolean(meta?.isReply) || Boolean(quotedId);
  if (!isReply || !quotedId) return null;

  const quoted = String(meta?.quotedMessage ?? "").toLowerCase();
  const isQuotedMedia =
    /^\[(sticker|image|video|gif|audio|media|figurinha|imagem)\]/i.test(quoted) ||
    Boolean(meta?.media?.type) === false && /sticker|figurinha|imagem|gif|video/i.test(quoted);

  const t = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const toImg =
    /\b(vira|virar|transforma|transformar|converte|converter|tira|tirar|faz|faca|fazer|manda|passa|coloca)\b/.test(
      t
    ) &&
    /\b(imagem|img|gif|foto|png|jpg)\b/.test(t);

  const toSticker =
    /\b(vira|virar|transforma|transformar|converte|converter|faz|faca|fazer|manda)\b/.test(t) &&
    /\b(figurinha|sticker|fig)\b/.test(t);

  const removeBg =
    /\b(remove|tira|tirar|tira)\b/.test(t) && /\b(fundo|background|bg)\b/.test(t);

  const optimize = /\b(otimiz|comprim|reduz)\b/.test(t) && /\b(figurinha|sticker)\b/.test(t);

  let command = null;
  if (toImg) command = "toimg";
  else if (toSticker) command = "sticker";
  else if (removeBg) command = "removebg";
  else if (optimize) command = "optimize";

  if (!command) return null;

  return {
    command,
    messageId: quotedId,
    isQuotedMedia,
    source: "reply_intent"
  };
}
