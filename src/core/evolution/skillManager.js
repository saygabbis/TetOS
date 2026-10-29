import { fork } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSkillCode, safeTrigger, triggerProblems } from "./safety.js";

const RUNNER = fileURLToPath(new URL("./skillRunner.js", import.meta.url));
const RUN_TIMEOUT_MS = 12_000;

const slugify = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "habilidade";

function writeAtomic(p, text) {
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

/**
 * Habilidades que a Teto escreve pra si mesma: pequenos programas com gatilho (regex) que rodam quando
 * a conversa pede, em processo isolado (skillRunner.js com --permission), e devolvem um texto que entra
 * no prompt. Entram no ar sem reiniciar; cada versão anterior fica guardada.
 */
export class SkillManager {
  constructor({ dir = "./data/evolution/skills", tools = {}, now = () => Date.now(), log = console, corpus = () => [] } = {}) {
    this.dir = dir;
    this.tools = tools; // { pesquisar(q), ler(url) }
    this.now = now;
    this.log = log;
    this.corpus = corpus; // mensagens reais recentes (pra recusar gatilho genérico demais)
    this.indexPath = join(dir, "index.json");
    this.index = this.readIndex();
  }

  readIndex() {
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf8"));
    } catch {
      return { skills: {} };
    }
  }

  saveIndex() {
    writeAtomic(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  list() {
    return Object.entries(this.index.skills).map(([slug, s]) => ({ slug, ...s }));
  }

  codeOf(slug) {
    const p = join(this.dir, `${slug}.js`);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  /** Habilidades ligadas cujo gatilho bate com a mensagem (no máximo 2). */
  match(text = "") {
    const t = String(text ?? "");
    if (!t.trim()) return [];
    const out = [];
    for (const [slug, s] of Object.entries(this.index.skills)) {
      if (!s.enabled) continue;
      if ((s.triggers ?? []).some((p) => safeTrigger(p)?.test(t))) out.push(slug);
      if (out.length >= 2) break;
    }
    return out;
  }

  memoryPath(slug) {
    return join(this.dir, "memory", `${slug}.json`);
  }

  /** Roda uma habilidade no processo isolado. */
  run(slug, input = {}, { code = null, timeoutMs = RUN_TIMEOUT_MS } = {}) {
    const src = code ?? this.codeOf(slug);
    if (!src) return Promise.resolve({ ok: false, error: "habilidade não existe" });
    let memory = {};
    try {
      memory = JSON.parse(readFileSync(this.memoryPath(slug), "utf8"));
    } catch {
      /* sem memória ainda */
    }
    return new Promise((resolve) => {
      let finished = false;
      const child = fork(RUNNER, [], {
        execArgv: ["--permission", `--allow-fs-read=${RUNNER}`],
        env: {},
        serialization: "json",
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      });
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr = (stderr + d).slice(-400);
      });
      const done = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          child.kill();
        } catch {
          /* já saiu */
        }
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, error: "demorou demais" }), timeoutMs);
      child.on("error", (e) => done({ ok: false, error: e.message }));
      child.on("exit", (codeExit) => done({ ok: false, error: `processo saiu (${codeExit}) ${stderr.trim()}`.trim() }));
      child.on("message", async (msg) => {
        if (msg?.type === "tool") {
          const fn = this.tools[msg.name];
          try {
            if (!fn) throw new Error(`ferramenta desconhecida: ${msg.name}`);
            const value = await fn(...(msg.args ?? []));
            child.send({ type: "tool-result", id: msg.id, value });
          } catch (e) {
            child.send({ type: "tool-result", id: msg.id, error: e?.message ?? String(e) });
          }
          return;
        }
        if (msg?.type === "done") {
          if (msg.ok && msg.memory && slug) {
            try {
              writeAtomic(this.memoryPath(slug), JSON.stringify(msg.memory).slice(0, 50_000));
            } catch {
              /* memória é opcional */
            }
          }
          done(msg.ok ? { ok: true, text: msg.text ?? "" } : { ok: false, error: msg.error });
        }
      });
      child.send({ type: "run", code: src, input, memory });
    });
  }

  /** Linhas pro prompt com o resultado das habilidades que a mensagem acionou. */
  async contextFor(text, ctx = {}) {
    const slugs = this.match(text);
    if (!slugs.length) return [];
    const results = await Promise.all(
      slugs.map(async (slug) => {
        const r = await this.run(slug, { texto: String(text).slice(0, 1500), plataforma: ctx.platform ?? null, grupo: Boolean(ctx.isGroup), quem: ctx.speaker ?? null });
        this.noteRun(slug, r);
        return r.ok && r.text ? `- ${this.index.skills[slug]?.name ?? slug}: ${r.text}` : null;
      })
    );
    const lines = results.filter(Boolean);
    return lines.length
      ? ["[SUAS HABILIDADES — você criou e elas acabaram de rodar]", ...lines, "Use o resultado na resposta do seu jeito (não diga que 'rodou uma habilidade')."]
      : [];
  }

  noteRun(slug, result) {
    const s = this.index.skills[slug];
    if (!s) return;
    s.uses = (s.uses ?? 0) + 1;
    if (!result.ok) {
      s.errors = (s.errors ?? 0) + 1;
      s.lastError = String(result.error ?? "").slice(0, 200);
      // Falhando direto: desliga sozinha (volta a funcionar se ela consertar).
      if (s.errors >= 5 && s.errors / s.uses > 0.5) s.enabled = false;
    }
    try {
      this.saveIndex();
    } catch {
      /* índice é recriado */
    }
  }

  /**
   * Instala (ou atualiza) uma habilidade: confere o código, roda o exemplo isolado e só então liga.
   * A versão anterior fica em .versions/.
   * @returns {{ ok: boolean, slug?: string, problems?: string[], sample?: string }}
   */
  async install({ name, description = "", triggers = [], example = "", code = "" } = {}) {
    const slug = slugify(name);
    const check = checkSkillCode(code);
    const problems = [...check.problems];
    const corpus = this.corpus?.() ?? [];
    const checked = triggers.map(String).map((p) => ({ p, issues: triggerProblems(p, corpus) }));
    const okTriggers = checked.filter((c) => !c.issues.length).map((c) => c.p);
    if (!okTriggers.length) problems.push(`nenhum gatilho bom: ${[...new Set(checked.flatMap((c) => c.issues))].join("; ") || "nenhum gatilho"}`);
    if (example && okTriggers.length && !okTriggers.some((p) => safeTrigger(p).test(example))) problems.push("o exemplo não aciona o gatilho");
    if (problems.length) return { ok: false, slug, problems };
    const trial = await this.run(slug, { texto: example || name, plataforma: "teste", grupo: false, quem: "teste" }, { code });
    if (!trial.ok) return { ok: false, slug, problems: [`teste falhou: ${trial.error}`] };
    if (!String(trial.text ?? "").trim()) return { ok: false, slug, problems: ["teste não devolveu nada"] };
    const path = join(this.dir, `${slug}.js`);
    const at = new Date(this.now()).toISOString();
    if (existsSync(path)) {
      mkdirSync(join(this.dir, ".versions"), { recursive: true });
      writeAtomic(join(this.dir, ".versions", `${slug}-${Date.now()}.js`), readFileSync(path, "utf8"));
    }
    writeAtomic(path, code);
    const prev = this.index.skills[slug];
    this.index.skills[slug] = {
      name: String(name).slice(0, 60),
      description: String(description).slice(0, 300),
      triggers: okTriggers.slice(0, 6),
      example: String(example).slice(0, 200),
      enabled: true,
      version: (prev?.version ?? 0) + 1,
      createdAt: prev?.createdAt ?? at,
      updatedAt: at,
      uses: prev?.uses ?? 0,
      errors: 0
    };
    this.saveIndex();
    return { ok: true, slug, sample: String(trial.text).slice(0, 300) };
  }

  /**
   * Revisão das habilidades que já existem com as regras atuais: gatilho ruim sai; sem gatilho bom,
   * a habilidade é desligada. Devolve o que mudou.
   */
  audit() {
    const corpus = this.corpus?.() ?? [];
    const changes = [];
    for (const [slug, s] of Object.entries(this.index.skills)) {
      if (!s.enabled) continue;
      const bad = (s.triggers ?? []).map((p) => ({ p, issues: triggerProblems(p, corpus) })).filter((c) => c.issues.length);
      if (!bad.length) continue;
      s.triggers = (s.triggers ?? []).filter((p) => !bad.some((b) => b.p === p));
      const why = [...new Set(bad.flatMap((b) => b.issues))].join("; ");
      if (!s.triggers.length) {
        s.enabled = false;
        s.note = `desligada na revisão: ${why}`.slice(0, 200);
      }
      changes.push({ slug, name: s.name, disabled: !s.enabled, removed: bad.map((b) => b.p), why });
    }
    if (changes.length) this.saveIndex();
    return changes;
  }

  setEnabled(slug, enabled, reason = "") {
    const s = this.index.skills[slug];
    if (!s) return null;
    s.enabled = Boolean(enabled);
    s.note = String(reason).slice(0, 200);
    this.saveIndex();
    return s;
  }

  /** Volta pra versão anterior (se houver). */
  rollback(slug) {
    const dir = join(this.dir, ".versions");
    if (!existsSync(dir)) return false;
    const versions = readdirSync(dir).filter((f) => f.startsWith(`${slug}-`)).sort();
    const last = versions.at(-1);
    if (!last) return false;
    writeAtomic(join(this.dir, `${slug}.js`), readFileSync(join(dir, last), "utf8"));
    renameSync(join(dir, last), join(dir, `${last}.restaurada`));
    if (this.index.skills[slug]) {
      this.index.skills[slug].enabled = true;
      this.index.skills[slug].errors = 0;
      this.saveIndex();
    }
    return true;
  }
}
