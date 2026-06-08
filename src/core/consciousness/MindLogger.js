import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class MindLogger {
  constructor(path, { enabled = true } = {}) {
    this.path = path;
    this.enabled = enabled;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
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
    return { enabled: this.enabled, path: this.path };
  }
}
