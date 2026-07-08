import { detectTetoNameCall, isLikelyVocativeNameCall } from "./tetoNameDetect.js";

/** Extrai contextInfo (quote, menções) de qualquer tipo de mensagem WA. */
export function extractContextInfo(unwrappedMessage = {}) {
  const sources = [
    unwrappedMessage?.extendedTextMessage,
    unwrappedMessage?.imageMessage,
    unwrappedMessage?.videoMessage,
    unwrappedMessage?.audioMessage,
    unwrappedMessage?.documentMessage,
    unwrappedMessage?.stickerMessage,
    unwrappedMessage?.buttonsResponseMessage,
    unwrappedMessage?.listResponseMessage
  ];
  for (const src of sources) {
    if (src?.contextInfo) return src.contextInfo;
  }
  return {};
}

function normalizeJidPhone(jid = "") {
  return String(jid ?? "")
    .split(":")[0]
    .replace(/@.+$/, "")
    .replace(/\D/g, "");
}

/** @ mention do WhatsApp bate com o JID/telefone do bot? */
export function botMentionedInJids(mentionedJids = [], botJid = "", botPhone = "") {
  if (!Array.isArray(mentionedJids) || mentionedJids.length === 0) return false;
  const botPhoneDigits = normalizeJidPhone(botPhone || botJid);
  const botJidNorm = String(botJid ?? "").split(":")[0].toLowerCase();

  return mentionedJids.some((raw) => {
    const jid = String(raw ?? "").split(":")[0].toLowerCase();
    if (!jid) return false;
    if (botJidNorm && jid === botJidNorm) return true;
    const mentionPhone = normalizeJidPhone(jid);
    return Boolean(botPhoneDigits && mentionPhone && mentionPhone === botPhoneDigits);
  });
}

const NAME_RE = /\b(teto|tete|tetozinha)\b/i;

/** "Teto" como teto da casa — não é chamar a bot. */
function isCeilingReference(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/\b(o|um|no|do|da|de|para|com)\s+teto\b/i.test(t)) return true;
  if (/\bteto\s+(da|do|de|baixo|alto|caiu|gotej|furou|rebentou|infiltr|molhad|pintar|reformar)\b/i.test(t)) {
    return true;
  }
  if (/\batingiu\s+o\s+teto\b/i.test(t)) return true;
  if (/\b(teto|forro)\s+(da|do|de)\s+/i.test(t)) return true;
  return false;
}

/** Chamada contextual ao nome da Teto (não @ e não reply). */
function isContextualNameCall(text = "") {
  const t = String(text ?? "").trim();
  if (!t || !NAME_RE.test(t)) return false;
  if (isCeilingReference(t)) return false;

  if (/^(oi+e?|oie+|eae+|hey+|e\s*a[ií])\s+(teto|tetozinha)\b/i.test(t)) return true;
  if (/^(teto|tetozinha)\b[,!?\s]/i.test(t)) return true;
  if (/\b(teto|tetozinha)\s*[!?]+$/i.test(t)) return true;
  if (/\b(minha\s+)?tetozinha\b/i.test(t)) return true;
  if (/\be\s+a[ií]\s+teto\b/i.test(t)) return true;
  if (/\b(ei|oi|hey)\s+(teto|tetozinha)\b/i.test(t)) return true;
  if (/\b(teto|tetozinha)[,]?\s+(como|vc|você|voce|me|faz|conta|olha|vem|cadê|cade|pode|ajuda|responde|fala)\b/i.test(t)) {
    return true;
  }
  if (/\b(teto|tetozinha)\s*[,]?\s*(qual|quem|onde|quando|por\s*que|pq|sera|será)\b/i.test(t)) return true;
  if (/\?\s*(teto|tetozinha)\b/i.test(t) || /\b(teto|tetozinha)\s*\?/i.test(t)) return true;

  return false;
}

/**
 * Classifica se a mensagem em grupo está falando com a Teto.
 * mention | reply | contextual | name_ambiguous | none
 */
export function classifyTetoAddress(text = "", { hasMention = false, isReplyToBot = false } = {}) {
  if (hasMention || /@\d{4,}/.test(String(text ?? ""))) return "mention";
  if (isReplyToBot) return "reply";

  const t = String(text ?? "").trim();
  if (!t) return "none";

  if (isCeilingReference(t)) return "none";

  const fuzzy = detectTetoNameCall(t);
  if (fuzzy.detected) {
    if (["kasane_teto", "stretched_teto", "fuzzy_teto", "tetozinha"].includes(fuzzy.variant)) {
      return "contextual";
    }
    if (isLikelyVocativeNameCall(t)) return "contextual";
  }

  if (isContextualNameCall(t)) return "contextual";
  if (NAME_RE.test(t) || fuzzy.detected) return "name_ambiguous";
  return "none";
}

/** Menção direta explícita (menção @, reply ou chamada contextual pelo nome). */
export function isDirectTetoAddress(text = "", opts = {}) {
  const kind = classifyTetoAddress(text, opts);
  return kind === "mention" || kind === "reply" || kind === "contextual";
}

/** Texto da mensagem citada no reply (quote). */
export function extractQuotedText(quotedMessageProto = null) {
  if (!quotedMessageProto) return "";
  const sources = [
    quotedMessageProto?.conversation,
    quotedMessageProto?.extendedTextMessage?.text,
    quotedMessageProto?.imageMessage?.caption,
    quotedMessageProto?.videoMessage?.caption,
    quotedMessageProto?.buttonsResponseMessage?.selectedDisplayText,
    quotedMessageProto?.listResponseMessage?.title
  ];
  for (const src of sources) {
    const t = String(src ?? "").trim();
    if (t) return t;
  }
  return "";
}

/**
 * Detecta se o reply/quote do usuário aponta para uma mensagem da Teto.
 * Não depende só do cache em memória — usa participant do WA + índice local.
 */
export function isQuotedMessageFromBot(
  contextInfo = {},
  {
    botJid = "",
    botPhone = "",
    snapshot = null,
    botActorIds = new Set(),
    messageIndex = null,
    channelId = null,
    quotedText = ""
  } = {}
) {
  if (snapshot?.actorId && botActorIds.has(snapshot.actorId)) return true;
  if (snapshot?.isFromBot) return true;

  const stanzaId = contextInfo?.stanzaId ?? null;
  if (stanzaId && messageIndex && channelId) {
    const indexed = messageIndex.get(channelId, stanzaId);
    if (indexed?.isFromBot || (indexed?.actorId && botActorIds.has(indexed.actorId))) {
      return true;
    }
  }

  const participant =
    contextInfo?.participant ??
    contextInfo?.participantAlt ??
    contextInfo?.quotedMessage?.key?.participant ??
    null;
  if (participant && (botJid || botPhone)) {
    if (botMentionedInJids([participant], botJid, botPhone)) return true;
    const pPhone = normalizeJidPhone(participant);
    const bPhone = normalizeJidPhone(botPhone || botJid);
    if (pPhone && bPhone && pPhone === bPhone) return true;
  }

  if (quotedText && messageIndex && channelId) {
    const match = messageIndex.findBotMessageByText(channelId, quotedText);
    if (match) return true;
  }

  return false;
}

/** Chave de quote normalizada para Baileys (grupo precisa de participant). */
export function normalizeQuoteKey(key, remoteJid) {
  if (!key?.id) return null;
  const out = {
    remoteJid: key.remoteJid ?? remoteJid,
    id: key.id,
    fromMe: Boolean(key.fromMe)
  };
  if (key.participant) out.participant = key.participant;
  return out;
}

/** Garante participant em grupo — sem isso o quote não aparece no WhatsApp. */
export function buildOutgoingQuoteKey(key, remoteJid, { participantId = null, participantJid = null } = {}) {
  const out = normalizeQuoteKey(key, remoteJid);
  if (!out) return null;
  const isGroup = String(remoteJid ?? "").endsWith("@g.us");
  if (!isGroup) return out;

  // Prefer participant already on the quote key (mensagem citada) — não sobrescrever com quem mandou a msg atual.
  let jid = key?.participant || out.participant || participantJid || null;
  if (!jid && participantId) {
    const phone = String(participantId).replace(/\D/g, "");
    if (phone.length >= 8) {
      jid = `${phone}@s.whatsapp.net`;
    }
  }

  if (jid && String(jid).includes("@")) {
    const [userPart, domainPart] = String(jid).split("@");
    const cleanUser = userPart.split(":")[0];
    out.participant = `${cleanUser}@${domainPart}`;
  }
  return out;
}

/**
 * Injeta contextInfo no payload (padrão Sellye/Baileys) — quote + menções reais no mesmo bloco.
 */
export function applyQuotedContextToPayload(payload = {}, quoteKey = null, indexedRow = null) {
  const mentionJids = Array.isArray(payload.mentions) ? payload.mentions.filter(Boolean) : [];
  const { mentions: _mentions, contextInfo: existingCtx, ...rest } = payload;

  if (!quoteKey?.id && !mentionJids.length) return payload;

  const contextInfo = { ...(existingCtx ?? {}) };

  if (quoteKey?.id) {
    contextInfo.stanzaId = quoteKey.id;
    contextInfo.participant = quoteKey.participant || indexedRow?.participantJid || "";
    const quotedText = String(indexedRow?.text ?? "").trim().slice(0, 500);
    contextInfo.quotedMessage = quotedText ? { conversation: quotedText } : {};
  }

  if (mentionJids.length) {
    const prev = Array.isArray(contextInfo.mentionedJid) ? contextInfo.mentionedJid : [];
    contextInfo.mentionedJid = [...new Set([...prev, ...mentionJids])];
  }

  const out = { ...rest, contextInfo };
  if (mentionJids.length) out.mentions = mentionJids;
  return out;
}

const VISUAL_MEDIA_TYPES = new Set(["image", "video", "gif", "sticker", "audio"]);

function isQuotedMediaContext(item = {}) {
  const quotedText = String(
    item?.replyThreadContext?.quoted?.text ?? item?.quotedMessage ?? ""
  ).trim();
  if (!quotedText) return false;
  return /^\[(sticker|image|video|gif|audio|media|figurinha|imagem)\]/i.test(quotedText);
}

/**
 * ID da mensagem que a resposta deve citar no WhatsApp.
 * Prioriza a mídia marcada no reply; senão a mídia que acabou de chegar.
 */
export function resolveOutgoingQuoteId(item = {}) {
  const triggerId = item?.messageKey?.id ?? null;
  const quotedId = item?.quotedMessageId ?? null;
  const mediaType = item?.media?.type ?? null;
  const isGroup = Boolean(item?.isGroup);

  if (quotedId && (item?.isReply || item?.quotedMessage || isQuotedMediaContext(item))) {
    return quotedId;
  }

  if (triggerId && mediaType && VISUAL_MEDIA_TYPES.has(mediaType)) {
    return triggerId;
  }

  if (quotedId && item?.isReply) {
    return quotedId;
  }

  if ((item?.batchedCount ?? 1) > 1 && triggerId) {
    return triggerId;
  }

  if (item?.sleepCatchUp && triggerId) {
    return triggerId;
  }

  // Grupo: citar quando endereçada ou em conversa ativa.
  if (
    isGroup &&
    triggerId &&
    (item?.isDirectMention ||
      item?.isReplyToBot ||
      item?.groupPriorityAddress ||
      item?.groupEngagementActive ||
      item?.isReply)
  ) {
    return triggerId;
  }

  return null;
}

export function shouldQuoteOutgoing(item = {}) {
  return Boolean(resolveOutgoingQuoteId(item));
}

export function buildQuoteKeyFromMessageId(
  chatMessageIndex,
  remoteJid,
  quoteId,
  { participantJid = null, participantId = null } = {}
) {
  const rawId = String(quoteId ?? "").trim();
  if (!rawId || !remoteJid) return null;
  const resolvedId =
    chatMessageIndex?.resolveQuoteMessageId?.(remoteJid, rawId) ?? rawId;
  const indexed = chatMessageIndex?.get?.(remoteJid, resolvedId);
  return buildOutgoingQuoteKey(
    {
      id: resolvedId,
      fromMe: Boolean(indexed?.isFromBot),
      participant: indexed?.participantJid ?? participantJid ?? null
    },
    remoteJid,
    { participantId, participantJid: indexed?.participantJid ?? participantJid ?? null }
  );
}
