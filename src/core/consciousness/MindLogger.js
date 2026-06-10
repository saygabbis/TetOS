import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLegacyMindLogPath } from "./mindLogPaths.js";

function dayKey(date = new Date(), timeZone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export class MindLogger {
  constructor(path, { enabled = true, timeZone = "America/Sao_Paulo" } = {}) {
    this.basePath = path;
    this.enabled = enabled;
    this.timeZone = timeZone;
    this.legacyMode = isLegacyMindLogPath(path);
    const dir = this.legacyMode ? dirname(path) : path;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  getDailyPath(timestamp = Date.now()) {
    if (this.legacyMode) return this.basePath;
    return join(this.basePath, `${dayKey(new Date(timestamp), this.timeZone)}.ndjson`);
  }

  append(entry = {}) {
    if (!this.enabled) return null;
    const record = {
      ts: entry.ts ?? new Date().toISOString(),
      turnId: entry.turnId ?? `turn_${Date.now()}`,
      input: entry.input ?? {},
      brain: entry.brain ?? {},
      promptBlocksUsed: entry.promptBlocksUsed ?? [],
      llm: entry.llm ?? {},
      output: entry.output ?? {}
    };
    const path = this.getDailyPath(Date.parse(record.ts));
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    return record;
  }

  logTurn({
    turnId,
    input,
    snapshot = {},
    timingPlan = null,
    memory = null,
    narrator = null,
    llm = null,
    output = null
  } = {}) {
    return this.append({
      turnId,
      input,
      brain: {
        emotion: snapshot.emotion ?? {},
        body: snapshot.emotion?.body ?? snapshot.body ?? {},
        health: snapshot.emotion?.health ?? snapshot.health ?? [],
        life: snapshot.life ?? {},
        social: snapshot.social ?? {},
        trustBond: snapshot.trustBond ?? {},
        worldContext: snapshot.world ?? {},
        music: snapshot.music ?? {},
        timing: { plan: timingPlan, reasons: timingPlan?.reasons ?? [] },
        memory: memory ?? {},
        media: snapshot.media ?? {},
        autonomous: snapshot.autonomous ?? {},
        subconscious: narrator?.subconscious ? [narrator.subconscious] : [],
        conscious: narrator?.conscious ? [narrator.conscious] : []
      },
      llm,
      output
    });
  }

  tick() {
    return {
      enabled: this.enabled,
      path: this.basePath,
      legacyMode: this.legacyMode,
      dailyPath: this.getDailyPath()
    };
  }
}
