import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildMindRecord } from "./mindLogCompact.js";
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
  constructor(path, { enabled = true, timeZone = "America/Sao_Paulo", mode = "slim" } = {}) {
    this.basePath = path;
    this.enabled = enabled;
    this.timeZone = timeZone;
    this.mode = mode === "full" ? "full" : "slim";
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
    const record = buildMindRecord(entry, { mode: this.mode });
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
    if (this.mode === "full") {
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
    return this.append({
      turnId,
      input,
      brain: {
        emotion: snapshot.emotion ?? {},
        trustBond: snapshot.trustBond ?? {},
        worldContext: snapshot.world ?? {},
        world: snapshot.world ?? {},
        health: snapshot.health ?? snapshot.emotion?.health ?? [],
        conscious: narrator?.conscious ? [narrator.conscious] : []
      },
      output
    });
  }

  tick() {
    return {
      enabled: this.enabled,
      path: this.basePath,
      legacyMode: this.legacyMode,
      mode: this.mode,
      dailyPath: this.getDailyPath()
    };
  }
}
