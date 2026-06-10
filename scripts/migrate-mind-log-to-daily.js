#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readNdjsonStream } from "../src/infra/ndjsonReader.js";

const legacyPath = process.argv[2] ?? "./data/mindLog.ndjson";
const targetDir = process.argv[3] ?? "./data/mind-log";

if (!existsSync(legacyPath)) {
  console.error(`Arquivo legado nao encontrado: ${legacyPath}`);
  process.exit(1);
}

if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

let total = 0;
const byDay = {};

readNdjsonStream(legacyPath).forEach((entry) => {
  const day = String(entry.ts ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  const path = join(targetDir, `${day}.ndjson`);
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  byDay[day] = (byDay[day] ?? 0) + 1;
  total += 1;
});

console.log(`Migradas ${total} entradas de ${legacyPath} -> ${targetDir}`);
console.log(Object.entries(byDay).map(([day, count]) => `- ${day}: ${count}`).join("\n"));
console.log(`Atualize TETOS_MIND_LOG_PATH=${targetDir}`);
