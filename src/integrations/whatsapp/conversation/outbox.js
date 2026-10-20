import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../../../infra/utils/fileStore.js";

/**
 * Caixa de saída entre processos: a API/MCP (outro processo) pede "manda isso no zap" e o runner
 * do WhatsApp, que tem a conexão, envia. Arquivo simples — a dona controla os dois lados.
 */
export function enqueueOutbox(path, { to, text = "", kind = "text", payload = null, by = "api" } = {}) {
  const t = String(text ?? "").trim();
  if (!to || (kind === "text" && !t)) throw new Error("to e text são obrigatórios");
  const data = readJson(path, { items: [] });
  const item = { id: randomUUID(), to: String(to), kind, text: t.slice(0, 4000), payload, by, status: "pending", createdAt: new Date().toISOString() };
  data.items = [...(data.items ?? []).slice(-200), item];
  writeJson(path, data);
  return item;
}

/** Pega o que está pendente e marca como "enviando" (quem chamou envia e depois marca sent/failed). */
export function takePendingOutbox(path) {
  const data = readJson(path, { items: [] });
  const pending = (data.items ?? []).filter((i) => i.status === "pending");
  if (!pending.length) return [];
  for (const i of pending) i.status = "sending";
  writeJson(path, data);
  return pending;
}

export function markOutbox(path, id, status, error = null) {
  const data = readJson(path, { items: [] });
  const item = (data.items ?? []).find((i) => i.id === id);
  if (!item) return;
  item.status = status;
  item.doneAt = new Date().toISOString();
  if (error) item.error = String(error).slice(0, 200);
  writeJson(path, data);
}
