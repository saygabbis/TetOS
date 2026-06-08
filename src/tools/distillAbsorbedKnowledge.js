#!/usr/bin/env node
import { createRuntime } from "../app/createRuntime.js";

const runtime = createRuntime();
const ledger = runtime.eventLedger;
const bridge = runtime.brainOrchestrator?.absorbed;

if (!bridge) {
  console.error("Brain desabilitado — ative TETOS_BRAIN_ENABLED=true");
  process.exit(1);
}

const days = process.argv.slice(2);
const targetDays = days.length ? days : [new Date().toISOString().slice(0, 10)];

for (const day of targetDays) {
  const path = `${ledger.basePath}/${day}.ndjson`;
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        bridge.ingestEvent(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    console.log(`Distilled ${lines.length} events from ${day}`);
  } catch (e) {
    console.warn(`Skip ${day}:`, e.message);
  }
}

bridge.save?.();
console.log("Patterns saved:", runtime.defaults.absorbedPatternsPath);
