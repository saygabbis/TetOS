import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { WebSocketServer } from "ws";
import { HubAgentLink } from "../../src/integrations/automate-hub/hubAgentLink.js";
import {
  applyOrganizerAction,
  buildOrganizerCommand,
  buildOrganizerReviewPrompt,
  formatOrganizerBlock,
  isHubOrganizerAvailable,
  resetHubOrganizer,
  setHubOrganizerLink,
  updateHubOrganizerFromFrame,
} from "../../src/integrations/automate-hub/hubOrganizer.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";

const ORGANIZER_TOOL = { name: "organizer", description: "Objetivos e agenda" };
const snapshot = () => ({
  goals: [
    {
      id: "goal_1", title: "Aprender inglês", outcome: "Conversar sem travar", dueAt: null, status: "active",
      autonomy: { canPlan: true, canReschedule: false, weekdays: [1, 2, 3], startHour: "08:00", endHour: "20:00" },
    },
    { id: "goal_2", title: "Antigo", outcome: "", dueAt: null, status: "paused", autonomy: {} },
  ],
  tasks: [{ id: "task_1", goalId: "goal_1", title: "Praticar conversação", status: "todo", plannedAt: "2099-01-05T09:00:00-03:00", dueAt: null }],
  events: [{ id: "ev_1", title: "Aula", startAt: "2099-01-06T10:00:00-03:00", endAt: "2099-01-06T11:00:00-03:00", fixed: true }],
  decisions: [{ id: "dec_1", status: "pending", description: "Mover a aula" }],
  settings: { timeZone: "America/Sao_Paulo", paused: false },
});

/** Link falso: guarda o que a Teto manda ao hub e responde como o hub responderia. */
function fakeLink(respond) {
  const requests = [];
  return {
    requests,
    isReady: () => true,
    request: vi.fn(async (frame) => {
      requests.push(frame);
      return respond(frame);
    }),
  };
}
const mcp = (obj) => ({ t: "result", result: { content: [{ type: "text", text: JSON.stringify(obj) }] } });

afterEach(() => resetHubOrganizer());

describe("buildOrganizerCommand", () => {
  it("monta os comandos do hub a partir dos argumentos posicionais, omitindo o que veio vazio", () => {
    expect(buildOrganizerCommand("task_create", ["goal_1", "Praticar", "2099-01-05T09:00:00-03:00", "", "30"])).toEqual({
      command: { type: "task.upsert", task: { goalId: "goal_1", title: "Praticar", plannedAt: "2099-01-05T09:00:00-03:00", durationMinutes: 30 } },
    });
    expect(buildOrganizerCommand("task_move", ["task_1", "2099-01-06T09:00:00-03:00"])).toEqual({
      command: { type: "task.upsert", task: { id: "task_1", plannedAt: "2099-01-06T09:00:00-03:00" } },
    });
    expect(buildOrganizerCommand("task_complete", ["task_1", ""])).toEqual({ command: { type: "task.complete", taskId: "task_1" } });
    expect(buildOrganizerCommand("task_complete", ["task_1", "run:r1"])).toEqual({ command: { type: "task.complete", taskId: "task_1", evidence: "run:r1" } });
    expect(buildOrganizerCommand("event_create", ["", "Aula", "2099-01-06T10:00:00-03:00", "2099-01-06T11:00:00-03:00"])).toEqual({
      command: { type: "event.upsert", event: { title: "Aula", startAt: "2099-01-06T10:00:00-03:00", endAt: "2099-01-06T11:00:00-03:00" } },
    });
    expect(buildOrganizerCommand("goal_propose", ["Correr", "Correr 5 km", ""])).toEqual({
      command: { type: "goal.upsert", goal: { title: "Correr", outcome: "Correr 5 km" } },
    });
  });

  it("recusa comando incompleto em vez de mandar lixo ao hub", () => {
    expect(buildOrganizerCommand("task_create", ["goal_1", ""])).toHaveProperty("error");
    expect(buildOrganizerCommand("task_move", ["task_1"])).toHaveProperty("error");
    expect(buildOrganizerCommand("event_create", ["", "Aula", "", ""])).toHaveProperty("error");
    expect(buildOrganizerCommand("nada", [])).toHaveProperty("error");
  });
});

describe("comandos de Objetivos na resposta da Teto", () => {
  it("vira ação organizer com os argumentos lidos de forma robusta (aspas escapadas e parênteses)", () => {
    const actions = parseActionCommands(
      'mensagem("Vou agendar."); tarefa("goal_1", "Ler \\"Hamlet\\" (cap. 1)", "2099-01-05T09:00:00-03:00", "", "45"); concluirTarefa("task_1", "run:r1")',
    );
    const organizer = actions.filter((a) => a.type === "organizer");
    expect(organizer).toHaveLength(2);
    expect(organizer[0]).toMatchObject({ command: "tarefa", op: "task_create", args: ["goal_1", 'Ler "Hamlet" (cap. 1)', "2099-01-05T09:00:00-03:00", "", "45"] });
    expect(organizer[1]).toMatchObject({ command: "concluirtarefa", op: "task_complete", args: ["task_1", "run:r1"] });
    expect(actions.some((a) => a.type === "message")).toBe(true);
  });
});

describe("applyOrganizerAction", () => {
  const action = { type: "organizer", command: "tarefa", op: "task_create", args: ["goal_1", "Praticar", "", "", ""] };

  function ready(link) {
    setHubOrganizerLink(link);
    updateHubOrganizerFromFrame({ accountTools: [ORGANIZER_TOOL] }, { replace: true });
  }

  it("aplica pelo hub sem deviceId e conta que foi feito", async () => {
    const link = fakeLink(() => mcp({ snapshot: snapshot() }));
    ready(link);
    const out = await applyOrganizerAction(action, { threadId: "thr_1" });
    expect(out).toMatchObject({ ok: true, pending: false });
    expect(link.requests[0]).toMatchObject({
      t: "call", tool: "organizer", threadId: "thr_1",
      args: { action: "command", command: { type: "task.upsert", task: { goalId: "goal_1", title: "Praticar" } } },
    });
    expect(link.requests[0]).not.toHaveProperty("deviceId");
  });

  it("decisão pendente: diz que NÃO foi aplicado e onde decidir", async () => {
    ready(fakeLink(() => mcp({ snapshot: snapshot(), decision: { id: "dec_9", description: "Mover a aula de quarta" } })));
    const out = await applyOrganizerAction({ ...action, op: "task_move", args: ["task_1", "2099-01-06T09:00:00-03:00"] });
    expect(out.pending).toBe(true);
    expect(out.text).toContain("ainda não foi aplicado");
    expect(out.text).toContain("Mover a aula de quarta");
    expect(out.text).toContain("Preciso de você");
  });

  it("erro do hub: conta o erro e que nada mudou", async () => {
    ready(fakeLink(() => { throw Object.assign(new Error("A atuação automática está pausada."), { code: "organizer_paused" }); }));
    const out = await applyOrganizerAction(action);
    expect(out).toMatchObject({ ok: false, pending: false });
    expect(out.text).toContain("pausada");
    expect(out.text).toContain("Nada foi alterado");
  });

  it("sem o hub, não promete nada nem chama ninguém", async () => {
    const out = await applyOrganizerAction(action);
    expect(out).toMatchObject({ ok: false });
    expect(out.text).toContain("Nada foi alterado");
  });

  it("argumentos incompletos nem chegam ao hub", async () => {
    const link = fakeLink(() => mcp({}));
    ready(link);
    const out = await applyOrganizerAction({ ...action, args: ["goal_1", ""] });
    expect(out.ok).toBe(false);
    expect(link.request).not.toHaveBeenCalled();
  });
});

describe("formatOrganizerBlock", () => {
  it("fica vazio sem o hub ou sem a ferramenta anunciada", () => {
    expect(formatOrganizerBlock()).toEqual([]);
    setHubOrganizerLink(fakeLink(() => mcp({})));
    expect(isHubOrganizerAvailable()).toBe(false);
    expect(formatOrganizerBlock()).toEqual([]);
  });

  it("lista só o que é útil (ativos, pendentes, próximos) com ids, autonomia e a regra de não prometer", () => {
    setHubOrganizerLink(fakeLink(() => mcp({})));
    updateHubOrganizerFromFrame({ accountTools: [ORGANIZER_TOOL], organizer: snapshot() }, { replace: true });
    const block = formatOrganizerBlock().join("\n");
    expect(block).toContain("goal_1");
    expect(block).toContain("planejar");
    expect(block).not.toContain("goal_2"); // pausado
    expect(block).toContain("task_1");
    expect(block).toContain("ev_1");
    expect(block).toContain("[FIXO");
    expect(block).toContain("Mover a aula");
    expect(block).toContain("NÃO diga que aplicou");
  });

  it("assistente pausado pelo usuário aparece no bloco", () => {
    setHubOrganizerLink(fakeLink(() => mcp({})));
    updateHubOrganizerFromFrame({ accountTools: [ORGANIZER_TOOL], organizer: { ...snapshot(), settings: { timeZone: "America/Sao_Paulo", paused: true } } }, { replace: true });
    expect(formatOrganizerBlock().join("\n")).toContain("PAUSADO");
  });
});

describe("buildOrganizerReviewPrompt", () => {
  it("é um evento do sistema, não fala do usuário, e proíbe tarefa no PC", () => {
    const p = buildOrganizerReviewPrompt({ goalId: "goal_1", text: "Acompanhamento autorizado: Inglês" });
    expect(p).toContain("EVENTO DO SISTEMA");
    expect(p).toContain("goal_1");
    expect(p).toContain("Acompanhamento autorizado: Inglês");
    expect(p).toContain("NÃO agradeça");
    expect(p).toContain("computador(");
  });
});

describe("HubAgentLink com Objetivos", () => {
  let server;
  let wss;
  let link;

  afterEach(async () => {
    link?.stop();
    for (const c of wss?.clients ?? []) c.close();
    await new Promise((r) => wss?.close(() => server.close(r)));
  });

  async function connect({ readyExtra = {}, onFrame } = {}) {
    server = http.createServer();
    wss = new WebSocketServer({ server });
    const received = [];
    let socket;
    wss.on("connection", (ws) => {
      socket = ws;
      ws.on("message", (raw) => {
        const f = JSON.parse(String(raw));
        received.push(f);
        if (f.t === "hello") ws.send(JSON.stringify({ t: "ready", agent: { id: "tetos", name: "Teto" }, devices: [], ...readyExtra }));
        else onFrame?.(f, ws);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const dispatchUiRequest = vi.fn(async () => ({ status: 202, headers: {}, body: null }));
    link = new HubAgentLink({
      config: { url: `ws://127.0.0.1:${server.address().port}`, agentId: "tetos", token: "t", capabilities: ["chat", "rpc"], contextMethods: [], protocol: 1, heartbeatMs: 60_000, reconnectMinMs: 50, reconnectMaxMs: 100 },
      dispatchUiRequest,
      uiBus: new UiEventBus(),
      onLog: () => {},
      onError: () => {},
    });
    link.start();
    await vi.waitFor(() => expect(link.isReady()).toBe(true));
    return { received, dispatchUiRequest, send: (f) => socket.send(JSON.stringify(f)) };
  }

  it("aprende a ferramenta no ready e passa a oferecer Objetivos; sem o anúncio, não oferece", async () => {
    await connect({ readyExtra: { accountTools: [ORGANIZER_TOOL] } });
    expect(isHubOrganizerAvailable()).toBe(true);
    link.stop();
    expect(isHubOrganizerAvailable()).toBe(false);
  });

  it("hub sem o recurso: nada de Objetivos", async () => {
    await connect();
    expect(isHubOrganizerAvailable()).toBe(false);
  });

  it("guarda o snapshot de cada mensagem e encaminha a fala do usuário como antes", async () => {
    const hub = await connect({ readyExtra: { accountTools: [ORGANIZER_TOOL] } });
    hub.send({
      t: "message", threadId: "thr_1", message: { id: "m1", role: "user", text: "como estão meus objetivos?" },
      organizer: snapshot(), accountTools: [ORGANIZER_TOOL],
    });
    await vi.waitFor(() => expect(hub.dispatchUiRequest).toHaveBeenCalled());
    expect(hub.dispatchUiRequest.mock.calls[0][0]).toMatchObject({ method: "POST", path: "/ui/threads/thr_1/messages", body: { text: "como estão meus objetivos?" } });
    expect(hub.dispatchUiRequest.mock.calls[0][0].body).not.toHaveProperty("organizerReview");
    expect(formatOrganizerBlock().join("\n")).toContain("goal_1");
  });

  it("acompanhamento agendado (mensagem de sistema) chega ao app marcado como revisão, não como fala do usuário", async () => {
    const hub = await connect({ readyExtra: { accountTools: [ORGANIZER_TOOL] } });
    hub.send({
      t: "message", threadId: "thr_2",
      message: { id: "s1", role: "system", text: "Acompanhamento autorizado: Inglês", meta: { organizer: { goalId: "goal_1", scheduled: true } } },
    });
    await vi.waitFor(() => expect(hub.dispatchUiRequest).toHaveBeenCalled());
    expect(hub.dispatchUiRequest.mock.calls[0][0].body).toMatchObject({ text: "Acompanhamento autorizado: Inglês", organizerReview: { goalId: "goal_1" } });
  });

  it("outra mensagem de sistema é ignorada (antes virava fala do usuário)", async () => {
    const hub = await connect({ readyExtra: { accountTools: [ORGANIZER_TOOL] } });
    hub.send({ t: "message", threadId: "thr_3", message: { id: "s2", role: "system", text: "aviso qualquer" } });
    hub.send({ t: "message", threadId: "thr_3", message: { id: "m3", role: "user", text: "oi" } });
    await vi.waitFor(() => expect(hub.dispatchUiRequest).toHaveBeenCalledTimes(1));
    expect(hub.dispatchUiRequest.mock.calls[0][0].body.text).toBe("oi");
  });

  it("aplica o comando pelo link real: call sem deviceId e resultado do hub", async () => {
    const hub = await connect({
      readyExtra: { accountTools: [ORGANIZER_TOOL] },
      onFrame: (f, ws) => {
        if (f.t === "call") ws.send(JSON.stringify({ id: f.id, ...mcp({ snapshot: snapshot() }) }));
      },
    });
    const out = await applyOrganizerAction({ command: "concluirtarefa", op: "task_complete", args: ["task_1", "run:r1"] }, { threadId: "thr_1" });
    expect(out.ok).toBe(true);
    const call = hub.received.find((f) => f.t === "call");
    expect(call).toMatchObject({ tool: "organizer", threadId: "thr_1", args: { action: "command", command: { type: "task.complete", taskId: "task_1", evidence: "run:r1" } } });
    expect(call).not.toHaveProperty("deviceId");
  });
});
