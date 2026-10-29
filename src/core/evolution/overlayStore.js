import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Camada de cima do código: as mudanças que a Teto faz em si mesma ficam em data/evolution/overlay/
 * (fora do git) e o carregador (overlayHooks.js) usa essas versões no lugar das originais.
 *  - deploy/git pull nunca conflita (o src/ do repo não é tocado);
 *  - toda versão anterior fica em data/evolution/backups/<mudança>/ (desfazer = devolver o backup);
 *  - se o arquivo original mudou no repo (deploy), a versão dela fica "desatualizada" e sai do ar sozinha.
 * Tudo síncrono e sem dependências: também roda no --import, antes do resto do app.
 */

export const sha1 = (text) => createHash("sha1").update(String(text ?? "")).digest("hex");

const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

function writeText(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

export class OverlayStore {
  /** @param {string} root raiz do repo (absoluta) */
  constructor(root, { dir = "data/evolution", now = () => Date.now() } = {}) {
    this.root = root;
    this.dir = resolve(root, dir);
    this.now = now;
    this.manifestPath = join(this.dir, "manifest.json");
    this.manifest = this.load();
  }

  load() {
    try {
      const m = JSON.parse(readText(this.manifestPath) ?? "{}");
      return { active: m.active ?? {}, changes: m.changes ?? [], paused: Boolean(m.paused), notes: m.notes ?? [] };
    } catch {
      return { active: {}, changes: [], paused: false, notes: [] };
    }
  }

  save() {
    writeText(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  originalPath(rel) {
    return join(this.root, rel);
  }

  overlayPath(rel) {
    return join(this.dir, "overlay", rel);
  }

  stagedPath(changeId, rel) {
    return join(this.dir, "staged", changeId, rel);
  }

  backupPath(changeId, rel) {
    return join(this.dir, "backups", changeId, rel);
  }

  /** Conteúdo em vigor (versão dela se houver, senão a original). */
  currentContent(rel) {
    return this.manifest.active[rel] ? readText(this.overlayPath(rel)) ?? readText(this.originalPath(rel)) : readText(this.originalPath(rel));
  }

  change(id) {
    return this.manifest.changes.find((c) => c.id === id) ?? null;
  }

  /** Prepara uma mudança (ainda não vale): grava em staged/<id>/. */
  stage(id, files, meta = {}) {
    for (const [rel, content] of Object.entries(files)) writeText(this.stagedPath(id, rel), content);
    const change = {
      id,
      files: Object.keys(files),
      baseSha: Object.fromEntries(Object.keys(files).map((rel) => [rel, sha1(readText(this.originalPath(rel)) ?? "")])),
      status: "testando",
      createdAt: new Date(this.now()).toISOString(),
      ...meta
    };
    this.manifest.changes.push(change);
    this.manifest.changes = this.manifest.changes.slice(-120);
    this.save();
    return change;
  }

  setStatus(id, status, extra = {}) {
    const c = this.change(id);
    if (!c) return null;
    Object.assign(c, { status, ...extra, [`${status}At`]: new Date(this.now()).toISOString() });
    this.save();
    return c;
  }

  /** Mudanças testadas e aprovadas que esperam o próximo reinício. */
  ready() {
    return this.manifest.changes.filter((c) => c.status === "aprovado");
  }

  /**
   * Coloca em vigor (vale no próximo reinício): guarda o que estava valendo como backup e copia a
   * versão nova pra overlay/.
   */
  promote(id) {
    const c = this.change(id);
    if (!c) return null;
    for (const rel of c.files) {
      const live = this.currentContent(rel);
      const wasOverlay = Boolean(this.manifest.active[rel]);
      writeText(this.backupPath(id, rel), live ?? "");
      c.backupKind = { ...(c.backupKind ?? {}), [rel]: wasOverlay ? "overlay" : "original" };
      writeText(this.overlayPath(rel), readText(this.stagedPath(id, rel)) ?? "");
      this.manifest.active[rel] = { changeId: id, baseSha: c.baseSha?.[rel] ?? sha1(readText(this.originalPath(rel)) ?? ""), at: new Date(this.now()).toISOString() };
    }
    c.status = "ativo";
    c.activeAt = new Date(this.now()).toISOString();
    this.save();
    return c;
  }

  /**
   * Desfaz uma mudança: cada arquivo volta pro que valia antes dela (original ou versão anterior dela).
   * Se uma mudança mais nova mexeu no mesmo arquivo, desfaz essa primeiro.
   */
  revert(id, reason = "") {
    const c = this.change(id);
    if (!c) return null;
    if (["aprovado", "testando"].includes(c.status)) return this.setStatus(id, "descartado", { reason });
    if (c.status !== "ativo") return c;
    const newer = this.manifest.changes.filter((x) => x.status === "ativo" && x.id !== id && x.files.some((f) => c.files.includes(f)) && String(x.activeAt) > String(c.activeAt));
    for (const x of newer) this.revert(x.id, `desfeito junto com ${id}`);
    for (const rel of c.files) {
      const kind = c.backupKind?.[rel] ?? "original";
      if (kind === "original") {
        delete this.manifest.active[rel];
        rmSync(this.overlayPath(rel), { force: true });
      } else {
        writeText(this.overlayPath(rel), readText(this.backupPath(id, rel)) ?? "");
        const prev = [...this.manifest.changes].reverse().find((x) => x.id !== id && x.status === "ativo" && x.files.includes(rel));
        if (prev) this.manifest.active[rel] = { ...this.manifest.active[rel], changeId: prev.id };
        else {
          delete this.manifest.active[rel];
          rmSync(this.overlayPath(rel), { force: true });
        }
      }
    }
    c.status = "desfeito";
    c.reason = reason;
    c.desfeitoAt = new Date(this.now()).toISOString();
    this.save();
    return c;
  }

  /** Arquivos cuja original mudou no repo desde que ela mexeu (deploy novo): tira do ar. */
  dropStale() {
    const dropped = [];
    for (const [rel, info] of Object.entries(this.manifest.active)) {
      const nowSha = sha1(readText(this.originalPath(rel)) ?? "");
      if (info.baseSha && nowSha !== info.baseSha) {
        const archive = join(this.dir, "stale", `${Date.now()}`, rel);
        mkdirSync(dirname(archive), { recursive: true });
        if (existsSync(this.overlayPath(rel))) copyFileSync(this.overlayPath(rel), archive);
        rmSync(this.overlayPath(rel), { force: true });
        delete this.manifest.active[rel];
        const c = this.change(info.changeId);
        if (c && c.status === "ativo") Object.assign(c, { status: "desatualizado", desatualizadoAt: new Date(this.now()).toISOString() });
        dropped.push({ rel, changeId: info.changeId });
      }
    }
    if (dropped.length) this.save();
    return dropped;
  }

  /**
   * Mapa pro carregador: URL do original → URL da versão dela. `stageId` inclui uma mudança em teste.
   */
  loaderMap({ stageId = null } = {}) {
    const map = {};
    for (const rel of Object.keys(this.manifest.active)) {
      const p = this.overlayPath(rel);
      if (existsSync(p)) map[pathToFileURL(this.originalPath(rel)).href] = pathToFileURL(p).href;
    }
    const staged = stageId ? this.change(stageId) : null;
    for (const rel of staged?.files ?? []) {
      const p = this.stagedPath(stageId, rel);
      if (existsSync(p)) map[pathToFileURL(this.originalPath(rel)).href] = pathToFileURL(p).href;
    }
    return map;
  }

  latestActive() {
    return [...this.manifest.changes].filter((c) => c.status === "ativo").sort((a, b) => String(b.activeAt).localeCompare(String(a.activeAt)))[0] ?? null;
  }

  note(text) {
    this.manifest.notes.push({ at: new Date(this.now()).toISOString(), text: String(text).slice(0, 300) });
    this.manifest.notes = this.manifest.notes.slice(-50);
    this.save();
  }
}
