import { detectAgentMediaReplyIntent } from "../../core/media/agentMediaReplyIntent.js";
import { isMediaDescribeRequest } from "../../core/media/visualKnowledgeIntent.js";
import { resolveVerifiedQuoteKey } from "./quoteMessageResolver.js";
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

function mentionLocalId(jid = "") {
  return String(jid ?? "").split(":")[0].replace(/@.+$/, "").trim();
}

function matchesBotActorId(localId = "", botActorIds = null) {
  const local = String(localId ?? "").trim();
  if (!local || !(botActorIds instanceof Set) || botActorIds.size === 0) return false;
  return botActorIds.has(local) || botActorIds.has(`dm-${local}`);
}

/** @ mention do WhatsApp bate com o JID/telefone/LID do bot? */
export function botMentionedInJids(
  mentionedJids = [],
  botJid = "",
  botPhone = "",
  { botActorIds = null } = {}
) {
  if (!Array.isArray(mentionedJids) || mentionedJids.length === 0) return false;
  const botPhoneDigits = normalizeJidPhone(botPhone || botJid);
  const botJidNorm = String(botJid ?? "").split(":")[0].toLowerCase();

  return mentionedJids.some((raw) => {
    const jid = String(raw ?? "").split(":")[0].toLowerCase();
    if (!jid) return false;
    if (botJidNorm && jid === botJidNorm) return true;
    if (matchesBotActorId(mentionLocalId(jid), botActorIds)) return true;
    const mentionPhone = normalizeJidPhone(jid);
    return Boolean(botPhoneDigits && mentionPhone && mentionPhone === botPhoneDigits);
  });
}

/** @ no WhatsApp aponta pra Teto — JID, LID, ou entrada isSelf no índice. */
export function mentionedJidsIncludeBot(
  mentionedJids = [],
  { botJid = "", botPhone = "", botActorIds = null, identityIndex = null } = {}
) {
  if (botMentionedInJids(mentionedJids, botJid, botPhone, { botActorIds })) return true;
  if (!Array.isArray(mentionedJids) || mentionedJids.length === 0) return false;
  for (const raw of mentionedJids) {
    const local = mentionLocalId(raw);
    if (!local) continue;
    const entry =
      identityIndex?.get?.(local) ??
      identityIndex?.get?.(`dm-${local}`) ??
      identityIndex?.get?.(String(raw ?? "").split(":")[0]);
    if (entry?.isSelf) return true;
  }
  return false;
}

/** Menção @ normalizada para a Teto (após identity index). */
function hasNormalizedTetoMention(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return (
    /@teto\b/i.test(t) ||
    /@kasane\s+teto\b/i.test(t) ||
    /@kasane\s+teto\s*🩸/i.test(t)
  );
}

const PERSON_NAME_RE = /\b(teto|tete|tetozinha)\b/i;
const BUILDING_PLACE_RE =
  /\b(casa|sala|quarto|banheiro|cozinha|garagem|predio|prédio|apartamento|telhado|forro|laje|comodo|cômodo)\b/i;
const SUMMON_RE =
  /\b(cad[eê]|cade|onde\s+(est[aá]|t[aá]|anda|foi)|aparece|psps|psiu|vem\s+c[aá]|chega\s+aqui)\b/i;
const ADDRESS_VERB_RE =
  /\b(olha|olhe|veja|ve|vê|escuta|ouve|reage|comenta|responde|fala|ajuda|guarda|salva|usa|manda|pega|coloca|aprende|memoriza|grava|vem|faz|conta|pode|me)\b/i;
const INTERJECTION_RE =
  /\b(ei+|oi+|oie+|eae+|hey+|fala+|caralho|porra|putz|eita|nossa|mano|vei|véi|pô|po|vsf|mlk|krl)\b/i;

/** "o teto" / goteira / teto da casa — não é a Kasane Teto. */
export function isCeilingReference(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/\batingiu\s+o\s+teto\b/i.test(t)) return true;
  if (/\b(forro|laje|goteira|infiltracao|infiltração|telhado|reboco)\b/i.test(t) && /\bteto\b/i.test(t)) {
    return true;
  }
  if (/\b(o|um|uns|no|num|do|dum|pelo)\s+teto\b/i.test(t)) return true;
  if (/\bteto\s+(da|do|de)\s+/i.test(t) && BUILDING_PLACE_RE.test(t)) return true;
  if (/\bteto\s+(baixo|alto|caiu|gotej|furou|rebentou|infiltr|molhad|pintar|reformar|vazand)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Artigo/pronome feminino: é a personagem, não o teto da casa nem o cantor. */
export function isFeminineTetoPerson(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return (
    /\b(a|à|essa|esta|aquela|minha|nossa)\s+(teto|tetozinha|tete)\b/i.test(t) ||
    /\b(teto|tetozinha)\s+(gata|linda|dourada|esperta|teimosa)\b/i.test(t)
  );
}

/** Chamada dirigida à Teto (vocativo, pedido, cadê, feminino). */
function isContextualNameCall(text = "") {
  const t = String(text ?? "").trim();
  if (!t || !PERSON_NAME_RE.test(t)) return false;
  if (isCeilingReference(t)) return false;

  if (isFeminineTetoPerson(t)) return true;
  if (SUMMON_RE.test(t)) return true;
  if (/\b(minha\s+)?tetozinha\b/i.test(t)) return true;

  if (new RegExp(`${INTERJECTION_RE.source}\\s*[,!]?\\s*(teto|tetozinha)\\b`, "i").test(t)) return true;
  if (/^(oi+e?|oie+|eae+|hey+|e\s*a[ií])\s+(teto|tetozinha)\b/i.test(t)) return true;
  if (/^(teto|tetozinha)\b[,!?:]/.test(t) || /^(teto|tetozinha)\b\s/i.test(t)) return true;
  if (/\b(teto|tetozinha)\s*[!?]+$/i.test(t)) return true;
  if (/\be\s+a[ií]\s+teto\b/i.test(t)) return true;
  if (/\b(ei|oi|hey)\s+(teto|tetozinha)\b/i.test(t)) return true;

  if (
    new RegExp(`\\b(teto|tetozinha)\\s*[,:]?\\s*${ADDRESS_VERB_RE.source}`, "i").test(t)
  ) {
    return true;
  }
  if (
    /\b(olha|olhe|veja|vê|escuta|ouve|reage|comenta|responde|fala|ajuda|guarda|salva|manda|pega|vem|faz|conta)[^.]{0,32}\b(teto|tetozinha)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(teto|tetozinha)\s*[,]?\s*(qual|quem|onde|quando|por\s*que|pq|sera|será|como|vc|você|voce)\b/i.test(t)) {
    return true;
  }
  if (/\?\s*(teto|tetozinha)\b/i.test(t) || /\b(teto|tetozinha)\s*\?/i.test(t)) return true;
  if (/\b(pra|para|pro|com)\s+(a\s+)?(teto|tetozinha)\b/i.test(t)) return true;

  return false;
}

/**
 * Classifica se a mensagem em grupo está falando com a Teto.
 * mention | reply | contextual | name_ambiguous | none
 */
export function classifyTetoAddress(text = "", { hasMention = false, isReplyToBot = false } = {}) {
  if (hasMention || /@\d{4,}/.test(String(text ?? "")) || hasNormalizedTetoMention(text)) {
    return "mention";
  }
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
  if (PERSON_NAME_RE.test(t) || fuzzy.detected) return "name_ambiguous";
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
  if (participant && (botJid || botPhone || botActorIds?.size)) {
    if (botMentionedInJids([participant], botJid, botPhone, { botActorIds })) return true;
    const pPhone = normalizeJidPhone(participant);
    const bPhone = normalizeJidPhone(botPhone || botJid);
    if (pPhone && bPhone && pPhone === bPhone) return true;
    if (matchesBotActorId(mentionLocalId(participant), botActorIds)) return true;
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

/** Reply de texto sobre mídia marcada — citar a mídia, não a bolha de texto. */
function shouldQuoteRepliedMediaInsteadOfTrigger(item = {}) {
  const quotedId = item?.quotedMessageId ?? null;
  if (!quotedId || !isQuotedMediaContext(item)) return false;

  const userText = String(item?.message ?? "").trim();
  if (!userText) return false;

  if (item?.mediaDescribeRequest || isMediaDescribeRequest(userText)) return true;

  const mediaIntent = detectAgentMediaReplyIntent(userText, {
    quotedMessageId: quotedId,
    isReply: item?.isReply,
    quotedMessage: item?.quotedMessage
  });
  return Boolean(mediaIntent?.messageId);
}

/**
 * ID da mensagem que a resposta deve citar no WhatsApp.
 * - Mensagem recebida com mídia → citar essa mensagem (triggerId).
 * - Reply de texto → citar a mensagem DO USUÁRIO (triggerId), não o que ele marcou.
 * - Exceção: pedido explícito sobre mídia marcada (descrever, converter, etc.) → quotedMessageId.
 */
export function resolveOutgoingQuoteId(item = {}) {
  const triggerId = item?.messageKey?.id ?? item?.messageId ?? null;
  const quotedId = item?.quotedMessageId ?? null;
  const mediaType = item?.media?.type ?? null;
  const isGroup = Boolean(item?.isGroup);
  const incomingIsMedia = Boolean(mediaType && VISUAL_MEDIA_TYPES.has(mediaType));

  if (triggerId && incomingIsMedia) {
    return triggerId;
  }

  if (triggerId && item?.isReply && !incomingIsMedia) {
    if (quotedId && shouldQuoteRepliedMediaInsteadOfTrigger(item)) {
      return quotedId;
    }
    return triggerId;
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

  if (triggerId && item?.isReplyToBot && !incomingIsMedia) {
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
  {
    participantJid = null,
    participantId = null,
    getWaMessageById = null,
    groupMemory = null,
    hintText = null
  } = {}
) {
  const rawId = String(quoteId ?? "").trim();
  if (!rawId || !remoteJid) return null;

  const resolved = resolveVerifiedQuoteKey({
    channelId: remoteJid,
    remoteJid,
    quoteId: rawId,
    chatMessageIndex,
    getWaMessageById,
    groupMemory,
    participantJid,
    participantId,
    hintText
  });

  if (!resolved.quoteKey) {
    if (resolved.reason === "not_found" && resolved.requestedId) {
      console.warn(
        `[quote] id inexistente ou distante (${resolved.requestedId}) — enviando sem reply`
      );
    }
    return null;
  }

  if (resolved.resolvedFrom && resolved.resolvedFrom !== resolved.messageId) {
    console.log(
      `[quote] ${resolved.resolvedFrom} → ${resolved.messageId} (${resolved.reason}, conf=${(resolved.confidence ?? 0).toFixed(2)})`
    );
  }

  return resolved.quoteKey;
}
