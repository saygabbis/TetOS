#!/usr/bin/env node
/**
 * Servidor MCP da Teto (stdio): deixa outros apps (Claude Desktop, AutoMate, qualquer cliente MCP)
 * conversarem com ela e usarem as coisas dela. Fala com a API local (TETOS_API_URL + TETOS_API_TOKEN),
 * então a memória e a vida são as mesmas do WhatsApp.
 *
 * Config no cliente MCP (ex.: claude_desktop_config.json):
 *   { "command": "node", "args": ["<caminho>/src/integrations/mcp/tetoMcpServer.js"],
 *     "env": { "TETOS_API_URL": "http://127.0.0.1:3000", "TETOS_API_TOKEN": "..." } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = String(process.env.TETOS_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const TOKEN = String(process.env.TETOS_API_TOKEN ?? "").trim();
const OWNER_ID = process.env.TETOS_MCP_USER_ID ?? "owner-mcp";

async function api(path, { method = "GET", body = null } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `API ${res.status}`);
  return json;
}

const text = (t) => ({ content: [{ type: "text", text: String(t) }] });

const server = new McpServer({ name: "teto", version: "1.0.0" });

server.registerTool(
  "conversar_com_teto",
  {
    title: "Conversar com a Teto",
    description: "Manda uma mensagem pra Kasane Teto (como a dona dela) e devolve o que ela respondeu.",
    inputSchema: { mensagem: z.string().min(1).describe("O que dizer pra Teto") }
  },
  async ({ mensagem }) => {
    const { replies } = await api("/chat", {
      method: "POST",
      body: { message: mensagem, userId: OWNER_ID, sessionId: "mcp", channelId: "mcp", isOwner: true }
    });
    const out = (Array.isArray(replies) ? replies : [replies]).filter(Boolean).join("\n");
    return text(out || "(ela não respondeu)");
  }
);

server.registerTool(
  "o_que_a_teto_esta_fazendo",
  {
    title: "O que a Teto está fazendo",
    description: "Rotina da Teto agora: atividade, se está livre/ocupada/dormindo, humor e o que fez hoje.",
    inputSchema: {}
  },
  async () => {
    const { lines, availability } = await api("/life/now");
    return text([...(lines ?? []).slice(0, 7), availability ? `(disponibilidade: ${availability.mode})` : ""].join("\n"));
  }
);

server.registerTool(
  "mandar_whatsapp",
  {
    title: "Mandar mensagem no WhatsApp pela Teto",
    description: "A Teto manda uma mensagem no PV do WhatsApp. `para` = \"dona\" ou número com DDI (ex.: 5511999999999).",
    inputSchema: {
      para: z.string().min(1).describe('"dona" ou número com DDI'),
      texto: z.string().min(1).max(4000).describe("Texto exato a enviar")
    }
  },
  async ({ para, texto }) => {
    const { queued } = await api("/whatsapp/send", { method: "POST", body: { to: para, text: texto } });
    return text(`Na fila de envio (${queued.id}). O WhatsApp da Teto manda em alguns segundos se estiver conectado.`);
  }
);

server.registerTool(
  "lembretes_da_teto",
  {
    title: "Lembretes",
    description: "Lista os lembretes em aberto que a Teto está guardando.",
    inputSchema: { userId: z.string().optional().describe("Filtrar por pessoa (id interno)") }
  },
  async ({ userId }) => {
    const q = new URLSearchParams({ filter: "open", ...(userId ? { userId } : {}) });
    const { reminders = [] } = await api(`/reminders?${q}`);
    if (!reminders.length) return text("Nenhum lembrete em aberto.");
    return text(reminders.map((r) => `- ${r.text}${r.dueAt ? ` (${new Date(r.dueAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })})` : ""}`).join("\n"));
  }
);

server.registerTool(
  "memoria_sobre_pessoa",
  {
    title: "O que a Teto lembra de alguém",
    description: "Caderno de memória da Teto sobre uma pessoa (resumo, fatos, pendências). Use o id interno (ex.: dm-5511…).",
    inputSchema: { userId: z.string().min(1) }
  },
  async ({ userId }) => {
    const { notebook } = await api(`/people/${encodeURIComponent(userId)}`);
    if (!notebook) return text("Ela ainda não tem caderno sobre essa pessoa.");
    const facts = (notebook.facts ?? []).map((f) => `- ${f.t}`).join("\n");
    const open = (notebook.threads ?? []).filter((t) => !t.done).map((t) => `- pendente: ${t.t}${t.due ? ` (${t.due})` : ""}`).join("\n");
    return text([notebook.summary, facts, open].filter(Boolean).join("\n"));
  }
);

await server.connect(new StdioServerTransport());
