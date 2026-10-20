#!/usr/bin/env node
// Limpeza de dados: dedupe de memórias, reparo de identidades e remoção de perfis-artefato.
// Faz backup do memory.json antes. Rode com o runner/API parados (eles mantêm o arquivo em memória).
import "dotenv/config";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { DEFAULTS } from "../infra/config/defaults.js";
import { LongTermMemory } from "../core/memory/longTerm.js";
import { pruneIdentityArtifactProfiles, repairProfileContamination } from "../core/channels/botIdentity.js";
import { flushJsonWrites, writeJson } from "../infra/utils/fileStore.js";

const memoryPath = DEFAULTS.memoryPath;
if (!existsSync(memoryPath)) {
  console.log(`nada a fazer: ${memoryPath} não existe`);
  process.exit(0);
}

const backup = `${memoryPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(memoryPath, backup);
console.log(`backup: ${backup}`);

const longTerm = new LongTermMemory(memoryPath);
const runtime = { longTerm, defaults: DEFAULTS };
const before = Object.keys(longTerm.data.profiles).length;

longTerm.dedupeAll?.();
const { removed } = pruneIdentityArtifactProfiles(runtime);
const { repaired } = repairProfileContamination(runtime);
longTerm.persist();
flushJsonWrites();

console.log(`perfis: ${before} → ${Object.keys(longTerm.data.profiles).length} (removidos ${removed}, reparados ${repaired})`);
console.log(`memórias: ${longTerm.data.entries.length}`);

// time.json / userPatterns.json acumularam chaves de "apelidos" ("oi", "kkk"…) quando apelido virava identidade.
// Chave válida tem dígito (tel/LID/sessão wa-dm:/wa-group:) ou é especial; palavra pura é lixo.
const KEEP_KEYS = new Set(["default", "local", "teto", "self"]);
const isJunkKey = (key) => {
  const k = String(key);
  return !/\d/.test(k) && !KEEP_KEYS.has(k.toLowerCase()) && !/^(test_|ui-)/.test(k);
};
for (const path of [DEFAULTS.timePath, DEFAULTS.userPatternsPath].filter(Boolean)) {
  if (!existsSync(path)) continue;
  copyFileSync(path, `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const state = JSON.parse(readFileSync(path, "utf8"));
  let dropped = 0;
  for (const map of Object.values(state)) {
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const key of Object.keys(map)) {
      if (isJunkKey(key) || String(key).startsWith("eval-")) {
        delete map[key];
        dropped += 1;
      }
    }
  }
  writeJson(path, state);
  console.log(`${path}: ${dropped} chaves lixo removidas`);
}
// Lembretes antigos sem horário nunca seriam entregues (o parser antigo criava a partir de qualquer "me lembra").
if (existsSync(DEFAULTS.remindersPath ?? "./data/reminders.json")) {
  const path = DEFAULTS.remindersPath ?? "./data/reminders.json";
  const data = JSON.parse(readFileSync(path, "utf8"));
  let closed = 0;
  for (const r of data.reminders ?? []) {
    if (!r.done && !r.dueAt) {
      r.done = true;
      r.deliveryError = "sem_horario";
      closed += 1;
    }
  }
  if (closed) {
    copyFileSync(path, `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    writeJson(path, data);
  }
  console.log(`${path}: ${closed} lembretes sem horário encerrados`);
}
console.log("sanitize complete");
