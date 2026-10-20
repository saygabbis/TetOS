import {
  buildGroupSegment,
  isGroupPriorityEntry,
  planGroupTurnSegments
} from "./groupTurnPlanner.js";

const MSG_THRESHOLD = Number(process.env.TETOS_GROUP_FLOOD_MSG_THRESHOLD ?? 8);
const SEGMENT_CAP = Number(process.env.TETOS_GROUP_FLOOD_SEGMENT_CAP ?? 3);
export const GROUP_QUEUE_DEPTH_CAP = Number(process.env.TETOS_GROUP_QUEUE_CAP ?? 4);
const RECENT_MS = Number(process.env.TETOS_GROUP_CATCHUP_RECENT_MS ?? 40_000);
const RECENT_COUNT = Number(process.env.TETOS_GROUP_CATCHUP_RECENT_COUNT ?? 6);

function entryKey(entry = {}) {
  return entry.messageKey?.id ?? `${entry.userId ?? "?"}:${entry.ts ?? 0}`;
}

function pickRecentEntries(sorted = []) {
  if (!sorted.length) return [];
  const lastTs = sorted[sorted.length - 1]?.ts ?? Date.now();
  const cutoff = lastTs - RECENT_MS;
  const recentByTime = sorted.filter((e) => (e.ts ?? 0) >= cutoff);
  const recentByCount = sorted.slice(-RECENT_COUNT);
  const keys = new Set([...recentByTime, ...recentByCount].map(entryKey));
  return sorted.filter((e) => keys.has(entryKey(e)));
}

const PRIORITY_MERGE_GAP_MS = 10_000;
const PRIORITY_MERGE_MAX = 4;

/**
 * Chamadas diretas quase simultâneas (3 pessoas: "teto…", "teto…", "teto…") viram UM turno que
 * responde todo mundo junto — gente não manda três respostas em fila. Comandos seguem separados.
 */
function buildPrioritySegments(entries = []) {
  const groups = [];
  for (const entry of entries) {
    const isCommand = Boolean(entry.tetosCommand || entry.parsedCommand);
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    const canJoin =
      last &&
      !isCommand &&
      !last.isCommand &&
      last.length < PRIORITY_MERGE_MAX &&
      (entry.ts ?? 0) - (prev?.ts ?? 0) <= PRIORITY_MERGE_GAP_MS;
    if (canJoin) last.push(entry);
    else {
      const g = [entry];
      g.isCommand = isCommand;
      groups.push(g);
    }
  }
  return groups
    .map((g) => buildGroupSegment(g))
    .filter(Boolean)
    .map((seg) => ({ ...seg, groupPriorityAddress: true }));
}

/**
 * Rajada em grupo: não enfileira dezenas de respostas — absorve o passado e responde só ao recente.
 * Entradas prioritárias (.tetos, menção, reply) nunca são descartadas.
 */
export function planFloodAwareGroupSegments(entries = []) {
  const sorted = [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const priorityEntries = sorted.filter((e) => isGroupPriorityEntry(e));
  const normalEntries = sorted.filter((e) => !isGroupPriorityEntry(e));
  const prioritySegments = buildPrioritySegments(priorityEntries);
  const normalSegments = planGroupTurnSegments(normalEntries);
  const flood =
    normalEntries.length >= MSG_THRESHOLD || normalSegments.length > SEGMENT_CAP;

  if (!flood) {
    return {
      mode: "normal",
      segments: [...prioritySegments, ...normalSegments],
      droppedCount: 0
    };
  }

  const recentEntries = pickRecentEntries(normalEntries);
  const droppedCount = Math.max(0, normalEntries.length - recentEntries.length);
  const catchUpSegment = buildGroupSegment(recentEntries);

  if (!catchUpSegment && !prioritySegments.length) {
    return { mode: "catchup", segments: [], droppedCount };
  }

  if (catchUpSegment) {
    catchUpSegment.groupCatchUp = true;
    catchUpSegment.groupCatchUpSkipped = droppedCount;
    catchUpSegment.groupFloodMode = true;
  }

  return {
    mode: "catchup",
    segments: [...prioritySegments, ...(catchUpSegment ? [catchUpSegment] : [])],
    droppedCount
  };
}

/** Compacta fila de grupo quando há backlog — evita minutos de atraso serial. */
export function compactGroupQueueSegments(queue = []) {
  if (queue.length <= GROUP_QUEUE_DEPTH_CAP) return queue;

  const priority = [];
  const normal = [];
  for (const item of queue) {
    if (isGroupPriorityEntry(item)) priority.push(item);
    else normal.push(item);
  }

  if (normal.length <= 1) {
    return [...priority, ...normal].slice(-GROUP_QUEUE_DEPTH_CAP);
  }

  const mergedMessage = normal.map((s) => String(s.message ?? "").trim()).filter(Boolean).join("\n---\n");
  const last = normal[normal.length - 1];
  const merged = {
    ...last,
    message: mergedMessage,
    batchedCount: normal.reduce((n, s) => n + (s.batchedCount ?? 1), 0),
    groupCatchUp: true,
    groupCatchUpSkipped: normal.length - 1,
    groupFloodMode: true,
    segmentMultiSpeaker: true,
    segmentParts: normal.flatMap((s) =>
      Array.isArray(s.segmentParts) ? s.segmentParts : [{ userId: s.userId, speakerName: s.pushName ?? null, message: s.message }]
    ),
    segmentSpeakers: [
      ...new Set(normal.flatMap((s) => s.segmentSpeakers ?? [s.userId]).filter(Boolean))
    ]
  };

  const compacted = [...priority, merged];
  if (compacted.length > GROUP_QUEUE_DEPTH_CAP) {
    return [...priority.slice(-Math.max(1, GROUP_QUEUE_DEPTH_CAP - 1)), merged];
  }
  return compacted;
}

const QUEUE_MERGE_WINDOW_MS = 15_000;

const partsOf = (seg) =>
  Array.isArray(seg.segmentParts) && seg.segmentParts.length
    ? seg.segmentParts
    : [{ userId: seg.userId, speakerName: seg.pushName ?? seg.userId ?? "alguém", message: seg.message }];

/**
 * Próximo turno do grupo: junta as chamadas diretas que se acumularam na fila enquanto ela respondia
 * (várias pessoas falando com ela ao mesmo tempo) num turno só. Comandos continuam sozinhos.
 */
export function takeNextGroupTurn(queue = []) {
  if (!queue.length) return { item: null, rest: [] };
  const [first, ...others] = queue;
  const isMergeable = (seg) => isGroupPriorityEntry(seg) && !seg.tetosCommand && !seg.parsedCommand;
  if (!isMergeable(first)) return { item: first, rest: others };
  const batch = [first];
  const rest = [];
  for (const seg of others) {
    const closeInTime = Math.abs((seg.ts ?? 0) - (first.ts ?? 0)) <= QUEUE_MERGE_WINDOW_MS;
    if (isMergeable(seg) && closeInTime && batch.length < 4) batch.push(seg);
    else rest.push(seg);
  }
  if (batch.length === 1) return { item: first, rest };
  batch.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const parts = batch.flatMap(partsOf);
  const speakers = [...new Set(parts.map((p) => p.userId))];
  const last = batch[batch.length - 1];
  return {
    item: {
      ...last,
      message: speakers.length > 1 ? parts.map((p) => `[${p.speakerName}]: ${p.message}`).join("\n") : parts.map((p) => p.message).join("\n"),
      segmentParts: parts,
      segmentSpeakers: speakers,
      segmentMultiSpeaker: speakers.length > 1,
      batchedCount: batch.reduce((n, s) => n + (s.batchedCount ?? 1), 0),
      groupPriorityAddress: true
    },
    rest
  };
}
