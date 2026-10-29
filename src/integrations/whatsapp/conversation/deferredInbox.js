import { readJson, writeJsonDeferred } from "../../../infra/utils/fileStore.js";

/**
 * Mensagens que chegaram enquanto a Teto dormia, estava ocupada ou na rua. Ficam guardadas (em disco —
 * reinício não perde nada) até a hora em que ela "pega o celular"; aí viram um turno só por conversa.
 */

const MAX_PER_SESSION = 15;

const speakerLabel = (e = {}) => e.pushName || e.userId || "alguém";

/** Só o que dá pra salvar em JSON (promessas e buffers ficam de fora). */
function serializable(entry = {}) {
  const { mediaVisionPromise, ...rest } = entry;
  // Promessa vira "{}" no JSON — e depois era esperada como se fosse a descrição da figurinha ("[object Object]").
  return JSON.parse(JSON.stringify(rest, (k, v) => (v && (v.type === "Buffer" || typeof v.then === "function") ? undefined : v)));
}

export class DeferredInbox {
  constructor(path = "./data/life/inbox.json", { now = () => Date.now() } = {}) {
    this.path = path;
    this.now = now;
    this.data = readJson(path, { sessions: {} });
    this.data.sessions ??= {};
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  /** Guarda a mensagem; o horário de resposta é o da 1ª (mensagens seguintes entram na mesma leva). */
  append(sessionId, entry = {}, { dueAt = this.now(), reason = "asleep", activity = null } = {}) {
    const key = String(sessionId ?? "default");
    const row = (this.data.sessions[key] ??= { entries: [], dueAt, reason, activity, heldAt: this.now() });
    row.entries.push({ ...serializable(entry), ts: entry.ts ?? this.now() });
    if (row.entries.length > MAX_PER_SESSION) row.entries = row.entries.slice(-MAX_PER_SESSION);
    this.save();
    return row.entries.length;
  }

  /**
   * A descrição da mídia (visão) chegou enquanto a mensagem estava guardada: atualiza a mensagem
   * guardada ("[sticker]" vira a descrição) pra ela ver a figurinha quando pegar o celular.
   */
  updateMedia(messageId, description) {
    if (!messageId || typeof description !== "string" || !description.trim()) return false;
    for (const row of Object.values(this.data.sessions)) {
      const entry = row.entries?.find((e) => e?.messageKey?.id === messageId);
      if (!entry?.media) continue;
      entry.media = { ...entry.media, transcript: description, visionAttempted: true, visionStatus: "ok" };
      if (/^\[[^\]]+\]$/.test(String(entry.message ?? "").trim())) entry.message = description;
      this.save();
      return true;
    }
    return false;
  }

  peekCount(sessionId) {
    return this.data.sessions[String(sessionId ?? "default")]?.entries?.length ?? 0;
  }

  dueAt(sessionId) {
    return this.data.sessions[String(sessionId ?? "default")]?.dueAt ?? null;
  }

  /** Antecipa a resposta (ex.: insistiram, ou ela acordou). */
  bringForward(sessionId, dueAt) {
    const row = this.data.sessions[String(sessionId ?? "default")];
    if (row && dueAt < row.dueAt) {
      row.dueAt = dueAt;
      this.save();
    }
  }

  flush(sessionId) {
    const key = String(sessionId ?? "default");
    const row = this.data.sessions[key];
    if (!row?.entries?.length) return null;
    delete this.data.sessions[key];
    this.save();
    return this.buildCatchUpEntry(row);
  }

  buildCatchUpEntry(row) {
    const list = row.entries.filter(Boolean);
    if (!list.length) return null;
    const last = list[list.length - 1];
    const singleSpeaker = new Set(list.map((e) => e.userId)).size <= 1;
    const message = singleSpeaker
      ? list.map((e) => String(e.message ?? "").trim()).filter(Boolean).join("\n")
      : list.map((e) => `[${speakerLabel(e)}]: ${String(e.message ?? "").trim()}`).join("\n");
    const heldMs = Math.max(0, this.now() - (list[0].ts ?? row.heldAt ?? this.now()));
    return {
      ...last,
      message,
      batchedCount: list.length,
      sleepCatchUp: row.reason === "asleep",
      sleepCatchUpCount: list.length,
      deferredCatchUp: { reason: row.reason, activity: row.activity, heldMinutes: Math.round(heldMs / 60000) },
      messageKey: last.messageKey,
      ts: last.ts ?? this.now()
    };
  }

  /** Conversas cuja hora de responder chegou. */
  drainDue(now = this.now()) {
    return Object.keys(this.data.sessions)
      .filter((k) => (this.data.sessions[k].dueAt ?? 0) <= now)
      .map((k) => this.flush(k))
      .filter(Boolean);
  }

  drainAll() {
    return Object.keys(this.data.sessions).map((k) => this.flush(k)).filter(Boolean);
  }
}
