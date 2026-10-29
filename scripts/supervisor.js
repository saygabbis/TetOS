#!/usr/bin/env node
// Mantém o runner do WhatsApp vivo: religa se o processo cair (espera crescente 2s→60s, zera após
// 10 min estável) e grava stdout/stderr em data/logs/runner-AAAA-MM-DD.log (7 dias de retenção).
// Uso: node scripts/supervisor.js [script]   (padrão: src/integrations/whatsapp/runner.js)
//
// Autoevolução da Teto:
//  - sobe o runner com a camada de código dela (--import overlayRegister.js);
//  - reinício pedido por ela (data/evolution/restart.json) religa na hora, sem contar como queda;
//  - caiu 2x seguidas logo depois de subir e ela tem código próprio no ar → próximo start em modo seguro
//    (TETOS_EVOLUTION_SAFE=1: sobe só com o código original; ela desfaz a última mudança e volta).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const script = process.argv[2] ?? "src/integrations/whatsapp/runner.js";
const LOG_DIR = process.env.TETOS_RUNNER_LOG_DIR ?? "./data/logs";
const KEEP_DAYS = Number(process.env.TETOS_RUNNER_LOG_DAYS ?? 7);
const STABLE_MS = 10 * 60 * 1000;
const FAST_CRASH_MS = 120 * 1000;
const EVOLUTION_DIR = resolve(process.env.TETOS_EVOLUTION_PATH ?? "./data/evolution");
const OVERLAY_REGISTER = resolve("src/core/evolution/overlayRegister.js");
mkdirSync(LOG_DIR, { recursive: true });

const logFile = () => join(LOG_DIR, `runner-${new Date().toISOString().slice(0, 10)}.log`);
const write = (chunk) => {
  process.stdout.write(chunk);
  try { appendFileSync(logFile(), chunk); } catch {}
};
const note = (msg) => write(`[supervisor ${new Date().toISOString()}] ${msg}\n`);

function pruneOldLogs() {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(LOG_DIR)) {
    const m = name.match(/^runner-(\d{4}-\d{2}-\d{2})\.log$/);
    if (m && Date.parse(m[1]) < cutoff) try { unlinkSync(join(LOG_DIR, name)); } catch {}
  }
}

/** Ela tem código próprio no ar? (só aí faz sentido o modo seguro) */
function hasOwnCode() {
  try {
    const m = JSON.parse(readFileSync(join(EVOLUTION_DIR, "manifest.json"), "utf8"));
    return Object.keys(m.active ?? {}).length > 0;
  } catch {
    return false;
  }
}

/** Reinício pedido por ela? (consome o aviso) */
function takePlannedRestart() {
  const flag = join(EVOLUTION_DIR, "restart.json");
  if (!existsSync(flag)) return null;
  try {
    const info = JSON.parse(readFileSync(flag, "utf8"));
    rmSync(flag, { force: true });
    return info;
  } catch {
    rmSync(flag, { force: true });
    return { reason: "?" };
  }
}

let child = null;
let stopping = false;
let backoffMs = 2000;
let fastCrashes = 0;
let safeNext = false;

function start() {
  pruneOldLogs();
  const startedAt = Date.now();
  const safe = safeNext;
  safeNext = false;
  note(`iniciando ${script}${safe ? " (MODO SEGURO: sem o código próprio da Teto)" : ""}`);
  const execArgv = existsSync(OVERLAY_REGISTER) ? ["--import", pathToFileURL(OVERLAY_REGISTER).href] : [];
  const env = { ...process.env, TETOS_SUPERVISED: "1", TETOS_EVOLUTION_SAFE: safe ? "1" : "" };
  child = spawn(process.execPath, [...execArgv, script], { stdio: ["ignore", "pipe", "pipe"], env });
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    const upMs = Date.now() - startedAt;
    const planned = takePlannedRestart();
    if (planned) {
      fastCrashes = 0;
      backoffMs = 2000;
      note(`reinício pedido pela Teto (${planned.reason ?? "?"}) — religando`);
      setTimeout(start, 1000);
      return;
    }
    if (upMs >= STABLE_MS) {
      backoffMs = 2000;
      fastCrashes = 0;
    }
    if (upMs < FAST_CRASH_MS) fastCrashes += 1;
    if (fastCrashes >= 2 && hasOwnCode() && !safe) {
      safeNext = true;
      fastCrashes = 0;
      try { writeFileSync(join(EVOLUTION_DIR, "crash.json"), JSON.stringify({ at: new Date().toISOString(), code, signal })); } catch {}
      note("caiu 2x seguidas com código próprio da Teto no ar — próximo start em modo seguro");
    }
    note(`runner saiu (code=${code} signal=${signal ?? "-"}) após ${Math.round(upMs / 1000)}s — religando em ${backoffMs / 1000}s`);
    setTimeout(start, backoffMs);
    backoffMs = Math.min(60_000, backoffMs * 2);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    note(`${sig} recebido — encerrando runner`);
    if (!child) return process.exit(0);
    child.kill(sig);
    setTimeout(() => process.exit(0), 15_000).unref();
  });
}

start();
