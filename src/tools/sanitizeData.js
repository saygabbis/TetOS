#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const memoryPath = process.env.TETOS_MEMORY_PATH ?? "./data/memory.json";

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const key = `${e.userId ?? ""}|${e.type ?? ""}|${e.content ?? e.value ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

if (existsSync(memoryPath)) {
  const raw = JSON.parse(readFileSync(memoryPath, "utf8"));
  if (Array.isArray(raw.entries)) {
    raw.entries = dedupeEntries(raw.entries);
    writeFileSync(memoryPath, JSON.stringify(raw, null, 2));
    console.log(`memory.json deduped: ${raw.entries.length} entries`);
  }
}

console.log("sanitize complete");
