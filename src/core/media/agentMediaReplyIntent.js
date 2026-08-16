function foldIntentText(text = "") {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeQuotedMedia(quoted = "") {
  const q = String(quoted ?? "").toLowerCase();
  return (
    /^\[(sticker|image|video|gif|audio|media|figurinha|imagem)\]/i.test(q) ||
    /sticker|figurinha|imagem|gif|video/.test(q)
  );
}

function looksLikeCommentary(t = "") {
  return /\b(adorei|amei|legal|massa|boa essa|kkk+|haha|mandou|recebi|toda hora|demais|melhor que|olha essa)\b/.test(
    t
  );
}

function looksLikeImperativeRequest(t = "") {
  const s = t
    .replace(/^(?:(?:teto|tete)[,\s]+)/, "")
    .replace(/^(?:(?:essa|esse|isso|isto)(?:\s+daqui)?(?:\s+(?:foto|imagem|video|gif|midia))?\s+)/, "")
    .trim();
  return (
    /^(?:(?:pode(?:s)?|consegue)\s+)?(?:(?:por favor|pfv|pf)\s+)?(?:(?:me|pra mim)\s+)?(?:faz(?:er)?|cria|manda|transforma|vira|converte|tira|remove|otimiza)/.test(
      s
    ) || /^(?:uma?\s+)?(?:figurinha|sticker|fig|imagem|foto)(?:\s|$)/.test(s)
  );
}

function resolveMediaCommandFromText(t = "") {
  if (!t || t.length > 100 || looksLikeCommentary(t) || !looksLikeImperativeRequest(t)) return null;

  const toImg =
    /\b(vira|virar|transforma|transformar|converte|converter|tira|tirar|faz|faca|fazer|manda|passa|coloca)\b/.test(
      t
    ) && /\b(imagem|img|gif|foto|png|jpg)\b/.test(t);

  const toSticker =
    (/\b(vira|virar|transforma|transformar|converte|converter|faz|faca|fazer|manda)\b/.test(t) &&
      /\b(figurinha|sticker|fig)\b/.test(t)) ||
    /^(?:uma?\s+)?(?:figurinha|sticker|fig)$/.test(t.trim());

  const removeBg = /\b(remove|tira|tirar)\b/.test(t) && /\b(fundo|background|bg)\b/.test(t);
  const optimize = /\b(otimiz|comprim|reduz)\b/.test(t) && /\b(figurinha|sticker)\b/.test(t);

  if (toSticker) return "sticker";
  if (toImg) return "toimg";
  if (removeBg) return "removebg";
  if (optimize) return "optimize";
  return null;
}

/**
 * Pedido natural de comando de mídia (reply OU mídia da própria mensagem).
 * Usado para executar direto, sem passar pela LLM.
 */
export function detectAgentMediaReplyIntent(text = "", meta = {}) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.startsWith(".")) return null;

  const quotedId = String(meta?.quotedMessageId ?? "").trim();
  const currentId = String(
    meta?.messageKey?.id ?? meta?.incomingMessageId ?? meta?.messageId ?? ""
  ).trim();
  const isReply = Boolean(meta?.isReply) || Boolean(quotedId);
  const hasOwnMedia = Boolean(meta?.media?.type);
  const quoted = String(meta?.quotedMessage ?? "");
  const isQuotedMedia = looksLikeQuotedMedia(quoted);

  let messageId = null;
  let source = null;
  if (isReply && quotedId && (isQuotedMedia || !hasOwnMedia)) {
    messageId = quotedId;
    source = "reply_intent";
  } else if (hasOwnMedia && currentId) {
    messageId = currentId;
    source = "self_media_intent";
  }
  if (!messageId) return null;

  const command = resolveMediaCommandFromText(foldIntentText(raw));
  if (!command) return null;

  return {
    command,
    messageId,
    isQuotedMedia: source === "reply_intent" ? isQuotedMedia : true,
    source
  };
}
