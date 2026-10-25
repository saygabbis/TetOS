import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyProjectAction,
  buildProjectEventPrompt,
  buildProjectFrame,
  formatHubContextBlock,
  normalizeHubContext,
  rememberThreadProject,
  resetHubProjects,
  setHubProjectsLink,
} from "../../src/integrations/automate-hub/hubProjects.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";
import { HubAgentLink } from "../../src/integrations/automate-hub/hubAgentLink.js";

afterEach(() => resetHubProjects());

const fakeLink = (request) => ({ isReady: () => true, request });

describe("contexto do hub", () => {
  it("normaliza o contexto e ignora quando vazio", () => {
    expect(normalizeHubContext({})).toBeNull();
    expect(normalizeHubContext({ contextText: " Memória: gosta de café ", projectId: "prj_1", kickoff: true })).toEqual({
      contextText: "Memória: gosta de café",
      projectId: "prj_1",
      kickoff: true,
    });
  });

  it("bloco de prompt traz a memória e, em projeto, os comandos de acompanhamento", () => {
    expect(formatHubContextBlock(null)).toEqual([]);
    const global = formatHubContextBlock({ contextText: "Memória sobre o usuário:\n- Mora em Curitiba", projectId: null }).join("\n");
    expect(global).toContain("Curitiba");
    expect(global).toContain("lembrar(");
    expect(global).not.toContain("itemProjeto(");
    const project = formatHubContextBlock({ contextText: "Projeto X", projectId: "prj_1" }).join("\n");
    expect(project).toContain("itemProjeto(");
    expect(project).toContain("PROPOSTA");
  });

  it("mensagem do hub com contexto chega à conversa com hubContext", async () => {
    const dispatchUiRequest = vi.fn(async () => ({ status: 202, headers: {}, body: "{}" }));
    const link = new HubAgentLink({
      config: { url: "ws://x/agent-link", agentId: "tetos", token: "t", capabilities: ["chat"] },
      dispatchUiRequest,
      uiBus: { publish: () => undefined, subscribe: () => () => undefined },
      onLog: () => undefined,
      onError: () => undefined,
    });
    await link.handleHubMessage({ t: "message", threadId: "th1", projectId: "prj_1", contextText: "Briefing: podcast", kickoff: true, message: { text: "oi" } });
    expect(dispatchUiRequest.mock.calls[0][0].body).toMatchObject({ text: "oi", hubContext: { projectId: "prj_1", contextText: "Briefing: podcast", kickoff: true } });
    await link.handleHubMessage({ t: "message", threadId: "th2", message: { text: "sem contexto" } });
    expect(dispatchUiRequest.mock.calls[1][0].body).toEqual({ text: "sem contexto" });
  });

  it("eventos do projeto abrem um turno de sistema na conversa do projeto", async () => {
    const dispatchUiRequest = vi.fn(async () => ({ status: 202, headers: {}, body: "{}" }));
    const link = new HubAgentLink({
      config: { url: "ws://x/agent-link", agentId: "tetos", token: "t", capabilities: ["chat"] },
      dispatchUiRequest,
      uiBus: { publish: () => undefined, subscribe: () => () => undefined },
      onLog: () => undefined,
      onError: () => undefined,
    });
    await link.handleMessage(JSON.stringify({ t: "task_due", projectId: "prj_1", threadId: "th9", item: { id: "itm_1", title: "Gerar relatório" }, requireApprovalForPc: true, context: "Projeto Ops" }));
    const call = dispatchUiRequest.mock.calls[0][0];
    expect(call.path).toBe("/ui/threads/th9/messages");
    expect(call.body.text).toContain("EVENTO DO SISTEMA");
    expect(call.body.text).toContain("itm_1");
    expect(call.body.projectEvent).toEqual({ kind: "task_due", requireApprovalForPc: true });
    expect(call.body.hubContext).toMatchObject({ projectId: "prj_1" });
  });
});

describe("comandos de projeto", () => {
  it("o parser reconhece os comandos e preserva texto livre", () => {
    const actions = parseActionCommands('itemProjeto("tarefa", "Revisar capítulo 3 (versão final)", "ver as notas", "usuario", "2026-11-01T10:00:00-03:00") lembrar("Prefere respostas curtas", "preferencia", "global")');
    expect(actions).toMatchObject([
      { type: "project", op: "item_upsert", command: "itemprojeto" },
      { type: "project", op: "memory_add", command: "lembrar" },
    ]);
    expect(actions[0].args[1]).toBe("Revisar capítulo 3 (versão final)");
  });

  it("monta os frames do hub com apelidos em português e valida", () => {
    expect(buildProjectFrame("item_upsert", ["decisao", "Paleta de cores", "", "teto", "", "semanal", "08:30"], { projectId: "p1" })).toEqual({
      frame: { t: "project", op: "item_upsert", projectId: "p1", item: { type: "decision", title: "Paleta de cores", owner: "agent", recurrence: { every: "week", interval: 1, time: "08:30" } } },
    });
    expect(buildProjectFrame("item_upsert", ["tarefa", ""], {})).toEqual({ error: "falta o título do item" });
    expect(buildProjectFrame("item_upsert", ["tarefa", "x", "", "alguem"], {})).toHaveProperty("error");
    expect(buildProjectFrame("item_status", ["itm_1", "feita", "ok"], { projectId: "p1" })).toEqual({
      frame: { t: "project", op: "item_status", projectId: "p1", itemId: "itm_1", status: "done", evidence: "ok" },
    });
    expect(buildProjectFrame("item_status", ["itm_1", "talvez"], {})).toHaveProperty("error");
    expect(buildProjectFrame("memory_add", ["Alérgico a amendoim", "fato", "global"], { projectId: "p1" })).toEqual({
      frame: { t: "project", op: "memory_add", text: "Alérgico a amendoim", category: "fact" },
    });
    expect(buildProjectFrame("memory_add", ["Voo dia 12"], { projectId: "p1" }).frame.projectId).toBe("p1");
  });

  it("aplica no hub e conta só o que houve (proposta, aprovação pendente, hub fora)", async () => {
    rememberThreadProject("th1", { projectId: "prj_1" });
    const request = vi.fn(async (frame) => (frame.op === "item_upsert" ? { item: { title: "Paleta", status: "proposed" } } : { item: { title: "Paleta", status: "done" } }));
    setHubProjectsLink(fakeLink(request));
    const proposed = await applyProjectAction({ command: "itemprojeto", args: ["decisao", "Paleta"] }, { threadId: "th1" });
    expect(proposed).toMatchObject({ ok: true });
    expect(proposed.text).toContain("proposta");
    expect(request.mock.calls[0][0]).toMatchObject({ t: "project", op: "item_upsert", projectId: "prj_1" });

    const blocked = vi.fn(async () => { throw Object.assign(new Error("Excluir precisa da aprovação"), { code: "needs_approval" }); });
    setHubProjectsLink(fakeLink(blocked));
    const del = await applyProjectAction({ command: "excluiritem", args: ["itm_1"] }, { threadId: "th1" });
    expect(del.ok).toBe(false);
    expect(del.text).toContain("aprovação");

    // fora de um projeto, só a memória funciona
    const none = await applyProjectAction({ command: "statusitem", args: ["itm_1", "feita"] }, { threadId: "sem-projeto" });
    expect(none.text).toContain("dentro de um projeto");

    resetHubProjects();
    expect((await applyProjectAction({ command: "lembrar", args: ["algo"] }, { threadId: "th1" })).text).toContain("fora do ar");
  });

  it("prompts dos eventos do sistema respeitam a aprovação para agir no PC", () => {
    const due = buildProjectEventPrompt({ t: "task_due", item: { id: "i1", title: "Backup" }, requireApprovalForPc: true });
    expect(due).toContain("exige aprovação");
    expect(buildProjectEventPrompt({ t: "task_due", item: { id: "i1", title: "Backup" }, requireApprovalForPc: false })).not.toContain("exige aprovação");
    expect(buildProjectEventPrompt({ t: "task_help", item: { id: "i2", title: "Enviar proposta", dueAt: "2026-11-01" } })).toContain("COMO fazer");
    expect(buildProjectEventPrompt({ t: "routine_result", routine: { name: "Backup", status: "failed", error: "disco cheio" } })).toContain("disco cheio");
    expect(buildProjectEventPrompt({ t: "nada" })).toBeNull();
  });
});

describe("resposta do hub ao frame project", () => {
  it("o request da TetOS é resolvido pela resposta t:project (e rejeitado por t:error)", async () => {
    const link = new HubAgentLink({
      config: { url: "ws://x/agent-link", agentId: "tetos", token: "t", capabilities: ["chat"], requestTimeoutMs: 2000 },
      dispatchUiRequest: async () => ({}),
      uiBus: { publish: () => undefined, subscribe: () => () => undefined },
      onLog: () => undefined,
      onError: () => undefined,
    });
    const sent = [];
    link.authenticated = true;
    link.ws = { readyState: 1, OPEN: 1, send: (raw) => sent.push(JSON.parse(raw)), close: () => undefined };
    const ok = link.request({ t: "project", op: "list" });
    await link.handleMessage(JSON.stringify({ t: "project", id: sent[0].id, op: "list", projects: [] }));
    await expect(ok).resolves.toMatchObject({ projects: [] });
    const bad = link.request({ t: "project", op: "item_delete" });
    await link.handleMessage(JSON.stringify({ t: "error", id: sent[1].id, code: "needs_approval", message: "precisa" }));
    await expect(bad).rejects.toMatchObject({ code: "needs_approval" });
  });
});
