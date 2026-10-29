// Ciclo completo da autoevolução com o SUPERVISOR DE VERDADE e a camada de código de verdade:
// mudança aprovada → reinício pedido por ela → versão dela carregada → mudança que quebra → duas quedas →
// modo seguro → ela desfaz sozinha → volta com a mudança boa. Não sobe zap nem Discord.
// Uso: node scripts/test-evolution-cycle.js
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, ok } from "./test-helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "tetos-cycle-"));
const statePath = join(tmp, "cycle-state.json");
const supervisor = spawn(process.execPath, ["scripts/supervisor.js", "scripts/test-evolution-cycle-runner.js"], {
  cwd: root,
  env: { ...process.env, TETOS_EVOLUTION_PATH: tmp, TETOS_RUNNER_LOG_DIR: join(tmp, "logs") },
  stdio: ["ignore", "pipe", "pipe"]
});
let out = "";
supervisor.stdout.on("data", (d) => (out += d));
supervisor.stderr.on("data", (d) => (out += d));

const read = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null);
const stopAll = () => {
  const s = read();
  try {
    if (s?.pid) process.kill(s.pid);
  } catch {}
  try {
    supervisor.kill();
  } catch {}
};

try {
  const until = Date.now() + 120_000;
  while (Date.now() < until && !read()?.done) await new Promise((r) => setTimeout(r, 500));
  const state = read();
  const log = (state?.log ?? []).join("\n");
  assert(state?.done, `o ciclo chegou ao fim\n${log}\n--- supervisor ---\n${out.slice(-2500)}`);
  assert(/2: marca=boa/.test(log), "depois do reinício pedido por ela, a versão dela carregou");
  assert(/reinício pedido pela Teto/.test(out), "supervisor tratou como reinício planejado");
  assert(/MODO SEGURO/.test(out), "duas quedas seguidas → modo seguro");
  assert(/modo seguro: desfiz a última mudança/.test(log), "no modo seguro ela desfez a última mudança");
  assert(/aviso pra dona: ⚠️ caí duas vezes/.test(log), "avisou a dona do rollback");
  assert(/marca=boa boa=ativo ruim=desfeito/.test(log), "voltou com a mudança boa e sem a ruim");
  ok("evolution cycle");
  stopAll();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  console.error(error.message ?? error);
  stopAll();
  process.exit(1);
}
