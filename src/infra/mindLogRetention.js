import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isLegacyMindLogPath } from "../core/consciousness/mindLogPaths.js";

export function sweepMindLogRetention(mindLogPath, maxDays = 14) {
  if (!mindLogPath || isLegacyMindLogPath(mindLogPath) || !existsSync(mindLogPath)) {
    return { removed: 0, kept: 0 };
  }
  const cutoff = Date.now() - Math.max(1, maxDays) * 86400000;
  let removed = 0;
  let kept = 0;
  for (const name of readdirSync(mindLogPath)) {
    if (!name.endsWith(".ndjson")) continue;
    const day = name.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const path = join(mindLogPath, name);
    const mtime = statSync(path).mtimeMs;
    const dayTs = Date.parse(`${day}T12:00:00.000Z`);
    const stale = Number.isFinite(dayTs) ? dayTs < cutoff : mtime < cutoff;
    if (stale) {
      unlinkSync(path);
      removed += 1;
    } else {
      kept += 1;
    }
  }
  return { removed, kept };
}
