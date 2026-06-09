import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { repairShortTermMessage, slimMetaForStorage } from "./slimMeta.js";

export class ShortTermMemory {
  constructor(limit = 8, { persistPath = null } = {}) {
    this.limit = limit;
    this.sessions = new Map();
    this.persistPath = persistPath;
    this.storeFile = this.persistPath ? join(this.persistPath, "sessions.json") : null;
    if (this.persistPath) {
      mkdirSync(this.persistPath, { recursive: true });
      this.loadAll();
    }
  }

  loadAll() {
    if (!this.storeFile) return;
    const data = readJson(this.storeFile, {});
    if (!data || typeof data !== "object") return;
    let dirty = false;
    for (const [sessionId, rows] of Object.entries(data)) {
      if (!Array.isArray(rows) || !rows.length) continue;
      const repaired = [];
      for (const row of rows) {
        const before = JSON.stringify(row ?? {}).length;
        const fixed = repairShortTermMessage(row);
        if (!fixed) {
          dirty = true;
          continue;
        }
        if (JSON.stringify(fixed).length < before - 40) dirty = true;
        repaired.push(fixed);
      }
      if (repaired.length) {
        this.sessions.set(sessionId, repaired.slice(-this.limit));
      } else {
        dirty = true;
      }
    }
    if (dirty) this.persistAll();
  }

  persistAll() {
    if (!this.storeFile) return;
    const data = {};
    for (const [sessionId, rows] of this.sessions.entries()) {
      if (rows?.length) data[sessionId] = rows;
    }
    writeJson(this.storeFile, data);
  }

  add(message, sessionId = "default") {
    const safe = repairShortTermMessage({
      role: message?.role,
      content: message?.content,
      meta: slimMetaForStorage(message?.meta ?? {})
    });
    if (!safe) return;

    const history = this.sessions.get(sessionId) ?? [];
    history.push(safe);
    if (history.length > this.limit) {
      history.splice(0, history.length - this.limit);
    }
    this.sessions.set(sessionId, history);
    this.persistAll();
  }

  getAll(sessionId = "default") {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  clear(sessionId = "default") {
    this.sessions.delete(sessionId);
    this.persistAll();
  }

  /** Remove a última mensagem da assistente (ex.: fallback terciário que descarta resposta). */
  popLastAssistant(sessionId = "default") {
    const history = this.sessions.get(sessionId) ?? [];
    if (history.length && history[history.length - 1]?.role === "assistant") {
      history.pop();
      this.sessions.set(sessionId, history);
      this.persistAll();
    }
  }
}
