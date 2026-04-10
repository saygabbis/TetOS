const ABSENCE_THRESHOLDS = {
  shortMaxMs: 2 * 60 * 60 * 1000,
  mediumMaxMs: 12 * 60 * 60 * 1000,
  longMaxMs: 48 * 60 * 60 * 1000
};

export function classifyAbsence(lastSeenAt, now = Date.now()) {
  if (!lastSeenAt) return { label: "short", gapMs: null };
  const last = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(last)) return { label: "short", gapMs: null };
  const gapMs = Math.max(0, now - last);
  if (gapMs < ABSENCE_THRESHOLDS.shortMaxMs) return { label: "short", gapMs };
  if (gapMs < ABSENCE_THRESHOLDS.mediumMaxMs) return { label: "medium", gapMs };
  if (gapMs < ABSENCE_THRESHOLDS.longMaxMs) return { label: "long", gapMs };
  return { label: "very_long", gapMs };
}
