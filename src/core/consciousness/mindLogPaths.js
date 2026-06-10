import { join } from "node:path";

export function isLegacyMindLogPath(path) {
  return String(path ?? "").endsWith(".ndjson");
}

export function resolveMindLogDailyPath(mindLogPath, day) {
  if (isLegacyMindLogPath(mindLogPath)) return mindLogPath;
  return join(mindLogPath, `${day}.ndjson`);
}
