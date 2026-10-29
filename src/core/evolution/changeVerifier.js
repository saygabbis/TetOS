import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Testa uma mudança que a Teto fez no próprio código ANTES de valer:
 *  1. sintaxe (node --check);
 *  2. o módulo carrega com a mudança (import isolado, sem tocar no data/ de verdade);
 *  3. a bateria de testes (scripts de test:brain:all) com a mudança — comparada com a mesma bateria
 *     sem a mudança, pra não culpar ela por teste que já falhava.
 * Tudo em processos filhos com prioridade baixa; nada disso mexe na Teto que está no ar.
 */

const isWin = process.platform === "win32";

function runNode(args, { cwd, env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const cmd = isWin ? process.execPath : "nice";
    const argv = isWin ? args : ["-n", "15", process.execPath, ...args];
    let out = "";
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d) => {
      out = (out + d).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      out += "\n[tempo esgotado]";
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, out: String(e?.message ?? e) });
    });
  });
}

/** Scripts da bateria (os `node scripts/x.js` de test:brain:all). */
export function testScriptsFrom(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return String(pkg.scripts?.["test:brain:all"] ?? "")
      .split("&&")
      .map((s) => s.trim().match(/^node\s+(scripts\/[\w.-]+\.js)$/)?.[1])
      .filter((s) => s && existsSync(join(root, s)));
  } catch {
    return [];
  }
}

export class ChangeVerifier {
  constructor({ root, store, evolutionDir = "data/evolution", log = console } = {}) {
    this.root = root;
    this.store = store;
    this.evolutionDir = evolutionDir;
    this.log = log;
    this.register = pathToFileURL(join(root, "src/core/evolution/overlayRegister.js")).href;
    this.isolated = pathToFileURL(join(root, "scripts/isolatedData.js")).href;
    this.baseline = null; // { key, failed: Set }
  }

  baseEnv(stageId) {
    return {
      TETOS_EVOLUTION_DIR: this.evolutionDir,
      ...(stageId ? { TETOS_EVOLUTION_STAGE: stageId } : { TETOS_EVOLUTION_STAGE: "" }),
      TETOS_EVOLUTION_SAFE: "",
      TETOS_EVOLUTION_READONLY: "1",
      TETOS_SUPERVISED: "",
      NODE_OPTIONS: ""
    };
  }

  async runSuite(stageId, { timeoutMs } = {}) {
    const scripts = testScriptsFrom(this.root);
    const failed = new Set();
    const logs = {};
    for (const script of scripts) {
      const r = await runNode(["--import", this.register, script], { cwd: this.root, env: this.baseEnv(stageId), timeoutMs: timeoutMs ?? 150_000 });
      if (!r.ok) {
        failed.add(script);
        logs[script] = r.out.slice(-800);
      }
    }
    return { scripts, failed, logs };
  }

  /** Bateria sem a mudança (guardada enquanto o código em vigor não mudar). */
  async baselineFailures() {
    const key = JSON.stringify(this.store.manifest.active) + String(this.headSha());
    if (this.baseline?.key === key) return this.baseline.failed;
    const { failed } = await this.runSuite(null);
    this.baseline = { key, failed };
    return failed;
  }

  headSha() {
    try {
      const head = readFileSync(join(this.root, ".git/HEAD"), "utf8").trim();
      const ref = head.match(/^ref: (.+)$/)?.[1];
      return ref ? readFileSync(join(this.root, ".git", ref), "utf8").trim() : head;
    } catch {
      return "";
    }
  }

  /**
   * @returns {{ ok: boolean, stage: string, details: string }}
   */
  async verify(changeId) {
    const change = this.store.change(changeId);
    if (!change) return { ok: false, stage: "mudança", details: "não existe" };
    for (const rel of change.files) {
      const r = await runNode(["--check", this.store.stagedPath(changeId, rel)], { cwd: this.root, timeoutMs: 30_000 });
      if (!r.ok) return { ok: false, stage: "sintaxe", details: `${rel}: ${r.out.slice(-600)}` };
    }
    for (const rel of change.files) {
      const url = pathToFileURL(join(this.root, rel)).href;
      const r = await runNode(
        ["--import", this.register, "--import", this.isolated, "--input-type=module", "-e", `await import(${JSON.stringify(url)}); console.log("ok"); process.exit(0);`],
        { cwd: this.root, env: this.baseEnv(changeId), timeoutMs: 60_000 }
      );
      if (!r.ok) return { ok: false, stage: "carregar", details: `${rel}: ${r.out.slice(-600)}` };
    }
    const before = await this.baselineFailures();
    const after = await this.runSuite(changeId);
    const broke = [...after.failed].filter((s) => !before.has(s));
    if (broke.length) {
      return { ok: false, stage: "testes", details: broke.map((s) => `${s}: ${after.logs[s] ?? ""}`).join("\n").slice(0, 1500) };
    }
    return { ok: true, stage: "ok", details: `${after.scripts.length} testes (${after.failed.size} já falhavam antes)` };
  }
}
