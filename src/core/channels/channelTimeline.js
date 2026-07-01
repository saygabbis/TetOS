/** Formato de histórico estilo Sellye — nome, id, texto, quote, você/outro. */

import {
  buildVisionByMessageId,
  enrichTimelineEntryText
} from "./mediaTimelineEnrich.js";

export const DEFAULT_CHANNEL_HISTORY_LIMIT = 24;

function escapeQuotes(text = "") {
  return String(text ?? "").replace(/"/g, '\\"');
}

function speakerLabel(entry = {}) {
  if (entry.isFromBot || entry.actorId === "teto") return "Teto (Você)";
  const name = entry.speakerName || entry.displayName || entry.actorId || "Usuário";
  if (String(name).includes("Gabbis( ˘ ³˘)♥")) return "Gabbis";
  return name;
}

/**
 * Uma linha do histórico: Nome (message id: X): "texto" + contexto de reply.
 */
export function formatChannelTimelineLine(entry = {}, quotedEntry = null, visionByMessageId = null) {
  const msgId = entry.messageId ?? entry.id ?? "?";
  const who = speakerLabel(entry);
  const rawText = enrichTimelineEntryText(entry, visionByMessageId).trim();
  const body = rawText ? `"${escapeQuotes(rawText)}"` : '""';
  const actorTag =
    entry.actorId && !entry.isFromBot && entry.actorId !== "teto"
      ? `; user id: ${entry.actorId}`
      : "";

  let line = `${who} (message id: ${msgId}${actorTag}): ${body}`;

  const quotedId = entry.quotedMessageId ?? entry.meta?.quotedMessageId ?? null;
  if (quotedId && quotedEntry) {
    const qWho = speakerLabel(quotedEntry);
    const qText = enrichTimelineEntryText(quotedEntry, visionByMessageId).trim().slice(0, 220);
    line += `\n  [↳ Respondendo à mensagem escrita por ${qWho}: "${escapeQuotes(qText)}"]`;
  } else if (quotedId) {
    line += `\n  [↳ Respondendo à message id: ${quotedId}]`;
  }

  if (entry.addressedToTeto === false) {
    line += "\n  [↳ (não era direcionado à Teto)]";
  }

  return line;
}

export function formatChannelTimelineText(entries = [], lookupQuoted = null, visionByMessageId = null) {
  const lines = entries.map((entry) => {
    const qid = entry.quotedMessageId ?? entry.meta?.quotedMessageId ?? null;
    const quoted = qid && lookupQuoted ? lookupQuoted(qid) : null;
    return formatChannelTimelineLine(entry, quoted, visionByMessageId);
  });
  return lines.filter(Boolean).join("\n\n");
}

/** Thread do índice em memória → entradas normalizadas. */
export function entriesFromChatIndex(chatMessageIndex, channelId, limit = DEFAULT_CHANNEL_HISTORY_LIMIT) {
  if (!chatMessageIndex?.getThread || !channelId) return [];
  return chatMessageIndex.getThread(channelId, limit);
}

/** Fallback: memória de grupo (todas as falas recentes do canal). */
export function entriesFromGroupMemory(groupMemory, channelId, limit = DEFAULT_CHANNEL_HISTORY_LIMIT) {
  const rows = groupMemory?.byChannel?.(channelId, { limit: limit * 2 }) ?? [];
  return rows
    .filter(
      (e) =>
        !(e.userId === "teto" && String(e.id ?? "").startsWith("gm_"))
    )
    .slice(0, limit)
    .reverse()
    .map((e) => ({
    messageId: e.id,
    channelId: e.channelId,
    actorId: e.userId,
    speakerName: e.userId === "teto" ? "Teto" : e.speakerName,
    text: e.text,
    isFromBot: e.userId === "teto",
    quotedMessageId: e.quotedMessageId ?? null,
    addressedToTeto: e.addressedToTeto !== false,
    ts: e.ts ?? null
  }));
}

function mergeTimelineEntries(indexEntries = [], gmEntries = [], cap = DEFAULT_CHANNEL_HISTORY_LIMIT) {
  const byId = new Map();
  for (const entry of [...gmEntries, ...indexEntries]) {
    const id = String(entry.messageId ?? entry.id ?? "").trim();
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, entry);
      continue;
    }
    const richer = entry.participantJid != null || entry.isFromBot != null ? entry : prev;
    byId.set(id, {
      ...prev,
      ...richer,
      text: richer.text || prev.text,
      ts: richer.ts || prev.ts,
      speakerName: richer.speakerName || prev.speakerName
    });
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.ts ?? 0) - Date.parse(b.ts ?? 0))
    .slice(-Math.max(1, Number(cap) || DEFAULT_CHANNEL_HISTORY_LIMIT));
}

/**
 * Monta histórico completo do canal para o prompt (índice WA + groupMemory, deduplicado).
 */
export function buildChannelTimelineForPrompt(
  runtime,
  { channelId, limit = DEFAULT_CHANNEL_HISTORY_LIMIT } = {}
) {
  const cap = Math.max(8, Number(limit) || DEFAULT_CHANNEL_HISTORY_LIMIT);
  const index = runtime?.chatMessageIndex ?? null;
  const indexEntries = entriesFromChatIndex(index, channelId, cap * 2);
  const gmEntries =
    channelId && runtime?.groupMemory
      ? entriesFromGroupMemory(runtime.groupMemory, channelId, cap * 2)
      : [];

  let entries = mergeTimelineEntries(indexEntries, gmEntries, cap);

  const visionByMessageId = buildVisionByMessageId(runtime, channelId, {
    stickersPath: runtime?.defaults?.stickersPath
  });
  if (visionByMessageId.size) {
    entries = entries.map((entry) => {
      const enriched = enrichTimelineEntryText(entry, visionByMessageId);
      if (enriched === entry.text) return entry;
      return { ...entry, text: enriched };
    });
  }

  let source = "merged";
  if (!entries.length && indexEntries.length) {
    entries = indexEntries.slice(-cap);
    source = "chatIndex";
  } else if (!entries.length && gmEntries.length) {
    entries = gmEntries.slice(-cap);
    source = "groupMemory";
  } else if (!entries.length) {
    source = "none";
  }

  const lookupQuoted = (quotedId) => {
    if (!quotedId || !index || !channelId) return null;
    return index.get(channelId, quotedId);
  };

  const text = formatChannelTimelineText(entries, lookupQuoted, visionByMessageId);
  return { entries, text, limit: cap, visionByMessageId };
}

/** Converte timeline em history[] para compat (role user/assistant). */
export function timelineToHistoryRows(entries = []) {
  return entries.map((entry) => ({
    role: entry.isFromBot ? "assistant" : "user",
    content: String(entry.text ?? entry.content ?? "").trim(),
    meta: {
      messageId: entry.messageId ?? entry.id ?? null,
      speakerName: entry.speakerName ?? null,
      userId: entry.actorId ?? entry.userId ?? null,
      quotedMessageId: entry.quotedMessageId ?? null,
      isFromBot: Boolean(entry.isFromBot),
      channelTimeline: true
    }
  }));
}
