import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function dayKey(timestamp = Date.now(), timeZone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

export class EventLedger {
  constructor({ basePath, timeZone = "America/Sao_Paulo", anonymizer = null } = {}) {
    this.basePath = basePath;
    this.timeZone = timeZone;
    this.anonymizer = anonymizer;
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  getDailyPath(timestamp = Date.now()) {
    return join(this.basePath, `${dayKey(timestamp, this.timeZone)}.ndjson`);
  }

  append(event = {}) {
    const ts = event.ts ?? new Date().toISOString();
    const normalized = {
      ts,
      eventType: event.eventType ?? "unknown",
      ...event
    };
    const safeEvent = this.anonymizer?.anonymizeEvent
      ? this.anonymizer.anonymizeEvent(normalized)
      : normalized;
    const path = this.getDailyPath(Date.parse(ts));
    appendFileSync(path, `${JSON.stringify(safeEvent)}\n`);
    return safeEvent;
  }
}
