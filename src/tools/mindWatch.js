#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { DEFAULTS } from "../infra/config/defaults.js";

const args = process.argv.slice(2);
const path = DEFAULTS.mindLogPath;
const dayFlag = args.indexOf("--day");
const day = dayFlag >= 0 ? args[dayFlag + 1] : null;
const summary = args.includes("--summary");
const full = args.includes("--full");
const tetoVoice = args.includes("--teto-voice");

function readLines() {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const entries = readLines().filter((e) => !day || String(e.ts ?? "").startsWith(day));

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
