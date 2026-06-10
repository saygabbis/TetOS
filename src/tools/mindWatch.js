#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isLegacyMindLogPath, resolveMindLogDailyPath } from "../core/consciousness/mindLogPaths.js";
import { DEFAULTS } from "../infra/config/defaults.js";
import { readNdjsonFile, readNdjsonStream } from "../infra/ndjsonReader.js";

const args = process.argv.slice(2);
const mindLogPath = DEFAULTS.mindLogPath;
const dayFlag = args.indexOf("--day");
const day = dayFlag >= 0 ? args[dayFlag + 1] : null;
const summary = args.includes("--summary");
const full = args.includes("--full");
const tetoVoice = args.includes("--teto-voice");

function readEntries() {
  if (isLegacyMindLogPath(mindLogPath)) {
    if (!existsSync(mindLogPath)) return [];
    return readNdjsonStream(mindLogPath, {
      lineFilter: day ? (line) => line.includes(day) : null
    }).filter((entry) => !day || String(entry.ts ?? "").startsWith(day));
  }
  if (day) {
    return readNdjsonFile(resolveMindLogDailyPath(mindLogPath, day));
  }
  if (!existsSync(mindLogPath)) return [];
  const files = readdirSync(mindLogPath)
    .filter((name) => name.endsWith(".ndjson"))
    .sort();
  const latest = files.at(-1);
  if (!latest) return [];
  return readNdjsonFile(join(mindLogPath, latest));
}

const entries = readEntries();

if (!entries.length) {
  console.log("Nenhuma entrada no mind log.");
  process.exit(0);
}

for (const entry of entries.slice(full ? 0 : -20)) {
  if (summary) {
    const conscious = entry.brain?.conscious ?? entry.brain?.life?.activity ?? "";
    console.log(`[${entry.ts}] turn=${entry.turnId ?? "?"} conscious=${String(conscious).slice(0, 60)}`);
    continue;
  }
  if (tetoVoice) {
    const sub = entry.brain?.subconscious ?? [];
    const out = entry.output?.processed ?? entry.output?.raw ?? "";
    console.log(`--- ${entry.ts} ---`);
    if (sub.length) console.log("pensando:", Array.isArray(sub) ? sub.join(" | ") : sub);
    if (out) console.log("saiu:", out);
    continue;
  }
  console.log(JSON.stringify(entry, null, full ? 2 : 0));
}
