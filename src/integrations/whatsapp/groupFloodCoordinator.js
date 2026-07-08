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

/**
 * Rajada em grupo: não enfileira dezenas de respostas — absorve o passado e responde só ao recente.
 */
export function planFloodAwareGroupSegments(entries = []) {
  const sorted = [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const normalSegments = planGroupTurnSegments(sorted);
  const flood =
    sorted.length >= MSG_THRESHOLD || normalSegments.length > SEGMENT_CAP;

  if (!flood) {
    return { mode: "normal", segments: normalSegments, droppedCount: 0 };
  }

  const recentEntries = pickRecentEntries(sorted);
  const droppedCount = Math.max(0, sorted.length - recentEntries.length);
  const catchUpSegment = buildGroupSegment(recentEntries);

  if (!catchUpSegment) {
    return { mode: "catchup", segments: [], droppedCount };
  }

  catchUpSegment.groupCatchUp = true;
  catchUpSegment.groupCatchUpSkipped = droppedCount;
  catchUpSegment.groupFloodMode = true;

  return {
    mode: "catchup",
    segments: [catchUpSegment],
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
    segmentSpeakers: [
      ...new Set(normal.flatMap((s) => s.segmentSpeakers ?? [s.userId]).filter(Boolean))
    ]
  };

  const compacted = [...priority, merged];
  if (compacted.length > GROUP_QUEUE_DEPTH_CAP) {
    return [...priority.slice(-1), merged];
  }
  return compacted;
}
