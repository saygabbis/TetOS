import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { clip, normText, shortId, similarity } from "./mindText.js";

export const TASK_KINDS = ["estudar", "habilidade", "codigo"];
const RETRY_GAP_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

/**
 * Agenda da Teto: o que ela decidiu estudar, que habilidade quer criar, que defeito no código quer
 * corrigir. Guarda quem pediu (pra avisar quando terminar) e o resultado.
 */
export class MindAgenda {
  constructor(path = "./data/mind/agenda.json", { now = () => Date.now(), max = 300 } = {}) {
    this.path = path;
    this.now = now;
    this.max = max;
    this.data = path ? readJson(path, { tasks: [] }) : { tasks: [] };
    this.data.tasks ??= [];
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  get tasks() {
    return this.data.tasks;
  }

  get(id) {
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  /**
   * Adiciona tarefa. Mesma coisa pendente não duplica (só sobe a prioridade e junta quem pediu).
   * @param {{ kind: string, title: string, detail?: string, priority?: number, requestedBy?: object|null, source?: string }} input
   */
  add({ kind, title, detail = "", priority = 0.5, requestedBy = null, source = "ela" } = {}) {
    if (!TASK_KINDS.includes(kind)) return null;
    const t = clip(title, 140);
    if (!t) return null;
    const open = this.tasks.find(
      (x) => x.kind === kind && ["pendente", "fazendo"].includes(x.status) && (normText(x.title) === normText(t) || similarity(x.title, t) >= 0.7)
    );
    if (open) {
      open.priority = Math.min(1, Math.max(open.priority, priority) + 0.1);
      if (requestedBy && !open.requesters?.some((r) => r.userId === requestedBy.userId)) {
        open.requesters = [...(open.requesters ?? []), requestedBy];
      }
      this.save();
      return { ...open, merged: true };
    }
    const task = {
      id: shortId(kind[0]),
      kind,
      title: t,
      detail: clip(detail, 800),
      priority: Math.max(0, Math.min(1, priority)),
      source,
      requesters: requestedBy ? [requestedBy] : [],
      status: "pendente",
      attempts: 0,
      createdAt: new Date(this.now()).toISOString(),
      lastTryAt: null,
      doneAt: null,
      result: null,
      notified: false
    };
    this.tasks.push(task);
    if (this.tasks.length > this.max) {
      const keep = this.tasks.filter((x) => ["pendente", "fazendo"].includes(x.status));
      const old = this.tasks.filter((x) => !["pendente", "fazendo"].includes(x.status)).slice(-(this.max - keep.length));
      this.data.tasks = [...old, ...keep];
    }
    this.save();
    return task;
  }

  /** Próxima tarefa a fazer (maior prioridade; quem pediu passa na frente; espera entre tentativas). */
  next(kinds = TASK_KINDS) {
    const now = this.now();
    const list = this.tasks.filter(
      (t) =>
        kinds.includes(t.kind) &&
        t.status === "pendente" &&
        (!t.lastTryAt || now - Date.parse(t.lastTryAt) >= RETRY_GAP_MS)
    );
    const weight = (t) => t.priority + (t.requesters?.length ? 0.3 : 0) + (t.requesters?.some((r) => r.isOwner) ? 0.2 : 0);
    return list.sort((a, b) => weight(b) - weight(a) || String(a.createdAt).localeCompare(String(b.createdAt)))[0] ?? null;
  }

  start(id) {
    const t = this.get(id);
    if (!t) return null;
    t.status = "fazendo";
    t.attempts += 1;
    t.lastTryAt = new Date(this.now()).toISOString();
    this.save();
    return t;
  }

  finish(id, result = null) {
    const t = this.get(id);
    if (!t) return null;
    t.status = "feito";
    t.doneAt = new Date(this.now()).toISOString();
    t.result = result;
    this.save();
    return t;
  }

  /** Falhou: volta pra fila (até 3 tentativas) ou desiste. */
  fail(id, error = "") {
    const t = this.get(id);
    if (!t) return null;
    t.status = t.attempts >= MAX_ATTEMPTS ? "desistiu" : "pendente";
    t.error = clip(error, 300);
    if (t.status === "desistiu") t.doneAt = new Date(this.now()).toISOString();
    this.save();
    return t;
  }

  cancel(id, reason = "") {
    const t = this.get(id);
    if (!t) return null;
    t.status = "cancelado";
    t.error = clip(reason, 200);
    this.save();
    return t;
  }

  /** Tarefas paradas em "fazendo" (o processo caiu no meio) voltam pra fila. */
  recover() {
    let changed = false;
    for (const t of this.tasks) {
      if (t.status === "fazendo") {
        t.status = "pendente";
        changed = true;
      }
    }
    if (changed) this.save();
  }

  pending(kind = null) {
    return this.tasks.filter((t) => t.status === "pendente" && (!kind || t.kind === kind));
  }

  /** Feitas (ou desistidas) com alguém esperando aviso. */
  awaitingNotice() {
    return this.tasks.filter((t) => ["feito", "desistiu"].includes(t.status) && !t.notified && t.requesters?.length);
  }

  markNotified(id) {
    const t = this.get(id);
    if (!t) return;
    t.notified = true;
    this.save();
  }

  doneToday(kind = null) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return this.tasks.filter((t) => (!kind || t.kind === kind) && String(t.doneAt ?? t.lastTryAt ?? "").startsWith(day) && t.status !== "pendente").length;
  }

  recent(n = 8) {
    return [...this.tasks].sort((a, b) => String(b.doneAt ?? b.createdAt).localeCompare(String(a.doneAt ?? a.createdAt))).slice(0, n);
  }
}

/** Diário da mente: uma linha por decisão/ação (ndjson), com rotação simples em 2 MB. */
export class MindJournal {
  constructor(path = "./data/mind/journal.ndjson", { maxBytes = 2_000_000, now = () => Date.now(), echo = Boolean(path) } = {}) {
    this.path = path;
    this.echo = echo; // aparece no log do runner (data/logs/runner-*.log)
    this.maxBytes = maxBytes;
    this.now = now;
    this.memory = [];
  }

  write(type, text, extra = {}) {
    const row = { ts: new Date(this.now()).toISOString(), type, text: clip(text, 400), ...extra };
    if (this.echo) console.log(`[mente] ${row.text}`);
    this.memory.push(row);
    this.memory = this.memory.slice(-200);
    if (!this.path) return row;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      if (existsSync(this.path) && statSync(this.path).size > this.maxBytes) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    } catch {
      /* diário não pode derrubar a Teto */
    }
    return row;
  }

  tail(n = 10) {
    if (this.memory.length >= n || !this.path || !existsSync(this.path)) return this.memory.slice(-n);
    try {
      const lines = readFileSync(this.path, "utf8").trim().split("\n").slice(-n);
      return lines.map((l) => JSON.parse(l));
    } catch {
      return this.memory.slice(-n);
    }
  }
}
