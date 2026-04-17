import { existsSync, readFileSync } from "node:fs";

export function readRecentLogs(path, limit = 200) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}

export function summarizeLogs(entries = []) {
  const summary = {
    total: entries.length,
    byEvent: {},
    lastTs: entries.length ? entries[entries.length - 1]?.ts ?? null : null
  };

  for (const entry of entries) {
    const event = entry?.event ?? "unknown";
    summary.byEvent[event] = (summary.byEvent[event] ?? 0) + 1;
  }

  return summary;
}
