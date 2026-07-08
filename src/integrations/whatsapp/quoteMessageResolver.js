import { buildOutgoingQuoteKey } from "./messageContext.js";

export const QUOTE_RESOLVE_MIN_CONFIDENCE = 0.75;
const MIN_PREFIX_OVERLAP = 8;

export function normalizeQuoteMessageId(raw = "") {
  return String(raw ?? "")
    .trim()
    .replace(/^\[?ID:\s*/i, "")
    .replace(/\]$/, "")
    .trim();
}

function isHexMessageId(id = "") {
  return /^[0-9A-F]{10,}$/i.test(String(id ?? ""));
}

function levenshtein(a = "", b = "") {
  const s = String(a).toUpperCase();
  const t = String(b).toUpperCase();
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function scoreMessageIdSimilarity(requested = "", candidate = "") {
  const req = normalizeQuoteMessageId(requested).toUpperCase();
  const cand = normalizeQuoteMessageId(candidate).toUpperCase();
  if (!req || !cand) return 0;
  if (req === cand) return 1;

  if (cand.startsWith(req) || req.startsWith(cand)) {
    const overlap = Math.min(req.length, cand.length);
    const span = Math.max(req.length, cand.length);
    if (overlap >= MIN_PREFIX_OVERLAP) {
      return 0.82 + (overlap / span) * 0.16;
    }
  }

  if (isHexMessageId(req) && isHexMessageId(cand)) {
    const tailLen = Math.min(12, req.length, cand.length);
    if (tailLen >= 8 && req.slice(-tailLen) === cand.slice(-tailLen)) {
      return 0.8 + tailLen / Math.max(req.length, cand.length) * 0.12;
    }

    const maxLen = Math.max(req.length, cand.length);
    const dist = levenshtein(req, cand);
    const maxAllowed = Math.max(3, Math.floor(maxLen * 0.18));
    if (dist <= maxAllowed) {
      return 0.72 + (1 - dist / (maxAllowed + 1)) * 0.22;
    }
  }

  return 0;
}

export function lookupIndexedMessage(channelId, messageId, { chatMessageIndex, groupMemory } = {}) {
  const id = normalizeQuoteMessageId(messageId);
  if (!id || !channelId) return null;

  const indexed = chatMessageIndex?.get?.(channelId, id);
  if (indexed) return indexed;

  const gmFound = groupMemory?.cache?.find?.(
    (entry) => entry?.id === id && entry?.channelId === channelId
  );
  if (!gmFound) return null;

  return {
    channelId,
    messageId: gmFound.id,
    actorId: gmFound.userId ?? null,
    speakerName: gmFound.speakerName ?? null,
    text: gmFound.text ?? "",
    isFromBot: gmFound.userId === "teto",
    remoteJid: gmFound.channelId,
    participantJid: gmFound.participantJid ?? null
  };
}

export function messageExistsInQuoteContext(channelId, messageId, ctx = {}) {
  const id = normalizeQuoteMessageId(messageId);
  if (!id || !channelId) return false;
  if (lookupIndexedMessage(channelId, id, ctx)) return true;
  const stored = ctx.getWaMessageById?.(id);
  return Boolean(stored?.key?.id && stored?.message);
}

function listCandidateMessageIds(channelId, { chatMessageIndex } = {}) {
  const thread = chatMessageIndex?.getThread?.(channelId, 80) ?? [];
  return [...new Set(thread.map((row) => normalizeQuoteMessageId(row?.messageId)).filter(Boolean))];
}

function resolveUserIdToLatestMessage(channelId, userId, { chatMessageIndex } = {}) {
  const raw = String(userId ?? "").trim();
  if (!raw || !/^\d{10,}$/.test(raw) || !chatMessageIndex) return null;
  const thread = chatMessageIndex.getThread(channelId, 60);
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const row = thread[i];
    if (row?.isFromBot || row?.actorId === "teto") continue;
    if (String(row?.actorId ?? "") === raw) return row.messageId;
  }
  return null;
}

function buildQuoteKeyFromIndexed(indexed, remoteJid, { participantJid = null, participantId = null } = {}) {
  if (!indexed?.messageId) return null;

  let resolvedParticipant = indexed.participantJid ?? participantJid ?? null;
  if (!resolvedParticipant && indexed.actorId) {
    if (String(indexed.actorId).includes("@")) {
      resolvedParticipant = indexed.actorId;
    } else if (/^\d{14,}$/.test(String(indexed.actorId))) {
      resolvedParticipant = `${indexed.actorId}@lid`;
    } else if (/^\d{8,}$/.test(String(indexed.actorId))) {
      resolvedParticipant = `${indexed.actorId}@s.whatsapp.net`;
    }
  }

  return buildOutgoingQuoteKey(
    {
      id: indexed.messageId,
      remoteJid: indexed.remoteJid || remoteJid,
      fromMe: Boolean(indexed.isFromBot),
      participant: resolvedParticipant
    },
    remoteJid,
    { participantId, participantJid: resolvedParticipant }
  );
}

/**
 * Valida e resolve o message id para quote/reply.
 * - Existe no índice/cache → usa direto.
 * - Não existe → tenta o id mais próximo no histórico recente.
 * - Confiança baixa ("viajou") → sem quote (null).
 */
export function resolveVerifiedQuoteKey({
  channelId,
  remoteJid,
  quoteId,
  chatMessageIndex = null,
  getWaMessageById = null,
  groupMemory = null,
  participantJid = null,
  participantId = null,
  hintText = null,
  minConfidence = QUOTE_RESOLVE_MIN_CONFIDENCE
} = {}) {
  const requestedId = normalizeQuoteMessageId(quoteId);
  if (!requestedId || !channelId || !remoteJid) {
    return { quoteKey: null, messageId: null, reason: "empty" };
  }

  const ctx = { chatMessageIndex, getWaMessageById, groupMemory };

  if (messageExistsInQuoteContext(channelId, requestedId, ctx)) {
    const indexed =
      lookupIndexedMessage(channelId, requestedId, ctx) ?? {
        messageId: requestedId,
        remoteJid,
        isFromBot: Boolean(getWaMessageById?.(requestedId)?.key?.fromMe),
        participantJid
      };
    return {
      quoteKey: buildQuoteKeyFromIndexed(indexed, remoteJid, { participantJid, participantId }),
      messageId: requestedId,
      reason: "exact",
      confidence: 1,
      requestedId
    };
  }

  const mappedUserId = resolveUserIdToLatestMessage(channelId, requestedId, ctx);
  if (mappedUserId && messageExistsInQuoteContext(channelId, mappedUserId, ctx)) {
    const indexed = lookupIndexedMessage(channelId, mappedUserId, ctx);
    return {
      quoteKey: buildQuoteKeyFromIndexed(indexed, remoteJid, { participantJid, participantId }),
      messageId: mappedUserId,
      reason: "user_id_map",
      confidence: 0.95,
      requestedId,
      resolvedFrom: requestedId
    };
  }

  if (hintText && chatMessageIndex?.findBotMessageByText) {
    const byText = chatMessageIndex.findBotMessageByText(channelId, hintText);
    if (byText?.messageId && messageExistsInQuoteContext(channelId, byText.messageId, ctx)) {
      return {
        quoteKey: buildQuoteKeyFromIndexed(byText, remoteJid, { participantJid, participantId }),
        messageId: byText.messageId,
        reason: "text_hint",
        confidence: 0.9,
        requestedId,
        resolvedFrom: requestedId
      };
    }
  }

  const candidates = listCandidateMessageIds(channelId, ctx);
  let bestId = null;
  let bestScore = 0;
  for (const candidateId of candidates) {
    const score = scoreMessageIdSimilarity(requestedId, candidateId);
    if (score > bestScore) {
      bestScore = score;
      bestId = candidateId;
    }
  }

  if (bestId && bestScore >= minConfidence && messageExistsInQuoteContext(channelId, bestId, ctx)) {
    const indexed = lookupIndexedMessage(channelId, bestId, ctx);
    return {
      quoteKey: buildQuoteKeyFromIndexed(indexed, remoteJid, { participantJid, participantId }),
      messageId: bestId,
      reason: "closest_id",
      confidence: bestScore,
      requestedId,
      resolvedFrom: requestedId
    };
  }

  return {
    quoteKey: null,
    messageId: null,
    reason: "not_found",
    confidence: bestScore,
    requestedId,
    bestCandidate: bestId
  };
}
