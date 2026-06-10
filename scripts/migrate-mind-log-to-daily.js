#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { compactMindEntry } from "../src/core/consciousness/mindLogCompact.js";
import { extractNdjsonDay, forEachNdjsonLine } from "../src/infra/ndjsonReader.js";

const args = process.argv.slice(2);
const slim = args.includes("--slim");
const legacyPath = args.find((arg) => !arg.startsWith("--")) ?? "./data/mindLog.ndjson";
const targetDir = args.filter((arg) => !arg.startsWith("--"))[1] ?? "./data/mind-log";

if (!existsSync(legacyPath)) {
  console.error(`Arquivo legado nao encontrado: ${legacyPath}`);
  process.exit(1);
}

if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

const sourceSizeMb = (statSync(legacyPath).size / (1024 * 1024)).toFixed(1);
console.log(`Migrando ${legacyPath} (${sourceSizeMb} MB) -> ${targetDir}${slim ? " [modo slim]" : ""}`);

let total = 0;
let skipped = 0;
const byDay = {};
let lastProgressAt = Date.now();

forEachNdjsonLine(legacyPath, (line) => {
  const day = extractNdjsonDay(line);
  if (!day) {
    skipped += 1;
    return;
  }
  const path = join(targetDir, `${day}.ndjson`);
  let payload;
  if (slim) {
    try {
      payload = `${JSON.stringify(compactMindEntry(JSON.parse(line)))}\n`;
    } catch {
      skipped += 1;
      return;
    }
  } else {
    payload = `${line}\n`;
  }
  appendFileSync(path, payload);
  byDay[day] = (byDay[day] ?? 0) + 1;
  total += 1;
  if (total % 500 === 0 || Date.now() - lastProgressAt > 15000) {
    console.log(`... ${total} linhas processadas`);
    lastProgressAt = Date.now();
  }
});

console.log(`Migradas ${total} entradas (${skipped} sem ts valido)`);
console.log(Object.entries(byDay).map(([day, count]) => `- ${day}: ${count}`).join("\n") || "(nenhum dia)");
console.log(`Atualize TETOS_MIND_LOG_PATH=${targetDir}`);
if (!slim) {
  console.log("Dica: rode de novo com --slim para compactar entradas e economizar disco.");
}
