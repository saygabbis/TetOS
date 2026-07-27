/**
 * Agrupa e separa turnos de grupo antes de responder.
 * Mesmo contexto → lê junto; contexto novo → segmento separado (cada um com quote).
 */

function speakerLabel(entry) {
  return entry.pushName || entry.userId || "alguém";
}

/** Menção, reply, comando ou chamada contextual — prioridade no batch/fila de grupo. */
export function isGroupPriorityEntry(entry = {}) {
  if (entry.groupPriorityAddress) return true;
  if (entry.tetosCommand || entry.parsedCommand) return true;
  return Boolean(
    entry.isDirectMention ||
    entry.isReplyToBot ||
    entry.groupAddressKind === "mention" ||
    entry.groupAddressKind === "reply" ||
    entry.groupAddressKind === "contextual"
  );
}

export function shouldSplitGroupSegment(prev, next) {
  if (!prev || !next) return true;
  const gap = (next.ts ?? 0) - (prev.ts ?? 0);
  if (gap > 55_000) return true;

  if (
    prev.quotedMessageId &&
    next.quotedMessageId &&
    prev.quotedMessageId !== next.quotedMessageId
  ) {
    return true;
  }

  if (next.isReplyToBot && prev.userId !== next.userId) return true;

  if (prev.userId !== next.userId) {
    if (gap > 14_000) return true;

    const prevToTeto =
      prev.isDirectMention || prev.isReplyToBot || prev.groupEngagementActive;
    const nextToTeto =
      next.isDirectMention || next.isReplyToBot || next.groupEngagementActive;
    if (prevToTeto && nextToTeto && gap < 25_000) return false;

    if (next.isDirectMention || next.isReplyToBot || next.groupEngagementActive) return true;
    if (prev.isDirectMention || prev.isReplyToBot) return true;
  }

  return false;
}

export function buildGroupSegment(entries = []) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return null;

  const last = list[list.length - 1];
  const singleSpeaker = new Set(list.map((e) => e.userId)).size === 1;

  const message = singleSpeaker
    ? list.map((e) => e.message).join("\n")
    : list.map((e) => `[${speakerLabel(e)}]: ${e.message}`).join("\n");

  const groupPriorityAddress = list.some(isGroupPriorityEntry);

  return {
    ...last,
    message,
    messageKey: last.messageKey,
    participantId: last.participantId ?? null,
    participantJid: last.participantJid ?? last.messageKey?.participant ?? null,
    batchedCount: list.length,
    segmentSpeakers: [...new Set(list.map((e) => e.userId))],
    segmentMultiSpeaker: !singleSpeaker,
    groupPriorityAddress,
    ts: last.ts ?? Date.now()
  };
}

export function planGroupTurnSegments(entries = []) {
  const sorted = [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const segments = [];
  let buf = [];

  const flush = () => {
    const seg = buildGroupSegment(buf);
    if (seg) segments.push(seg);
    buf = [];
  };

  for (const entry of sorted) {
    if (!buf.length) {
      buf.push(entry);
      continue;
    }
    const prev = buf[buf.length - 1];
    if (shouldSplitGroupSegment(prev, entry)) {
      flush();
    }
    buf.push(entry);
  }
  flush();
  return segments;
}
