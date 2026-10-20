#!/usr/bin/env node
// Mantém o runner do WhatsApp vivo: religa se o processo cair (espera crescente 2s→60s, zera após
// 10 min estável) e grava stdout/stderr em data/logs/runner-AAAA-MM-DD.log (7 dias de retenção).
// Uso: node scripts/supervisor.js [script]   (padrão: src/integrations/whatsapp/runner.js)
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const script = process.argv[2] ?? "src/integrations/whatsapp/runner.js";
const LOG_DIR = process.env.TETOS_RUNNER_LOG_DIR ?? "./data/logs";
const KEEP_DAYS = Number(process.env.TETOS_RUNNER_LOG_DAYS ?? 7);
const STABLE_MS = 10 * 60 * 1000;
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

let child = null;
let stopping = false;
let backoffMs = 2000;

function start() {
  pruneOldLogs();
  const startedAt = Date.now();
  note(`iniciando ${script}`);
  child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  child.stdout.on("data", write);
  child.stderr.on("data", write);
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    const upMs = Date.now() - startedAt;
    if (upMs >= STABLE_MS) backoffMs = 2000;
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
