import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { readHubAgentConfig } from "../../src/integrations/automate-hub/hubAgentConfig.js";
import { createUiHubDispatcher } from "../../src/integrations/automate-hub/uiHubDispatch.js";
import { HubAgentLink, isDurableHubEvent } from "../../src/integrations/automate-hub/hubAgentLink.js";
import { startHubAgentLinkIfConfigured } from "../../src/integrations/automate-hub/startHubAgentLink.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";
import { requireSession } from "../../src/infra/api/auth/sessionAuth.js";

const TOKEN = "tetos-dev-session";

function listenWss() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        wss,
        url: `ws://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.close();
            wss.close(() => server.close(done));
          }),
      });
    });
  });
}

function listenApp(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
      });
    });
  });
}

const baseConfig = {
  url: "ws://example/agent-link",
  agentId: "tetos",
  token: "secret",
  capabilities: ["chat", "rpc"],
  contextMethods: ["notifications/automate/"],
  protocol: 1,
  heartbeatMs: 60_000,
  reconnectMinMs: 50,
  reconnectMaxMs: 100,
};

describe("readHubAgentConfig", () => {
  it("retorna null sem URL ou token", () => {
    expect(readHubAgentConfig({})).toBeNull();
    expect(readHubAgentConfig({ TETOS_HUB_AGENT_URL: "ws://x" })).toBeNull();
    expect(readHubAgentConfig({ TETOS_HUB_AGENT_TOKEN: "t" })).toBeNull();
  });

  it("aplica defaults de id, capabilities e context.methods", () => {
    const cfg = readHubAgentConfig({
      TETOS_HUB_AGENT_URL: "ws://hub/agent-link",
      TETOS_HUB_AGENT_TOKEN: "secret",
    });
    expect(cfg.agentId).toBe("tetos");
    expect(cfg.capabilities).toEqual(["chat", "rpc"]);
    expect(cfg.contextMethods).toEqual(["notifications/automate/"]);
  });
});

describe("isDurableHubEvent", () => {
  it("marca aprovações e fim de execução como durable", () => {
    expect(isDurableHubEvent({ type: "permission.request" })).toBe(true);
    expect(isDurableHubEvent({ type: "run.status", status: "completed" })).toBe(true);
    expect(isDurableHubEvent({ type: "assistant.typing" })).toBe(false);
  });
});

describe("HubAgentLink", () => {
  let hub;
  let apiServer;

  afterEach(async () => {
    hub?.stop();
    hub = null;
    apiServer?.close();
    apiServer = null;
  });

  it("envia hello com context e responde rpc com rpc_result", async () => {
    const app = express();
    app.get("/ui/ping", requireSession, (_req, res) => res.json({ ok: true }));
    const api = await listenApp(app);
    apiServer = api.server;

    const uiBus = new UiEventBus();
    const dispatchUiRequest = createUiHubDispatcher(api.baseUrl, { sessionToken: TOKEN });
    const mockHub = await listenWss();

    const framesFromAgent = [];
    mockHub.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        framesFromAgent.push(frame);
        if (frame.t === "hello") {
          expect(frame.context).toEqual({ methods: ["notifications/automate/"] });
          ws.send(
            JSON.stringify({
              t: "ready",
              agent: { id: "tetos", name: "TetOS" },
              devices: [],
            }),
          );
          ws.send(JSON.stringify({ t: "ping" }));
          ws.send(
            JSON.stringify({
              t: "rpc",
              rpcId: "rpc-1",
              method: "GET",
              path: "/ui/ping",
              headers: {},
              body: null,
              bodyEncoding: "utf8",
              user: { id: "user-1" },
            }),
          );
        }
      });
    });

    hub = new HubAgentLink({
      config: { ...baseConfig, url: mockHub.url },
      dispatchUiRequest,
      uiBus,
      onLog: () => {},
      onError: () => {},
    });
    hub.start();

    await vi.waitFor(() => {
      expect(framesFromAgent.some((f) => f.t === "hello" && f.capabilities?.includes("rpc"))).toBe(
        true,
      );
      expect(framesFromAgent.some((f) => f.t === "rpc_result" && f.rpcId === "rpc-1")).toBe(true);
    });

    const rpcReply = framesFromAgent.find((f) => f.t === "rpc_result" && f.rpcId === "rpc-1");
    expect(rpcReply.status).toBe(200);
    expect(rpcReply.bodyEncoding).toBe("utf8");
    expect(JSON.parse(rpcReply.body)).toEqual({ ok: true });

    uiBus.publish({ type: "assistant.typing", threadId: "t1", isTyping: true });
    uiBus.publish({
      type: "message.final",
      threadId: "t1",
      message: { id: "a-1", role: "assistant", text: "oi" },
    });
    await vi.waitFor(() => {
      expect(framesFromAgent.some((f) => f.t === "event" && f.event?.type === "assistant.typing")).toBe(
        true,
      );
      expect(framesFromAgent.some((f) => f.t === "message" && f.message?.text === "oi")).toBe(true);
    });

    const typingEvent = framesFromAgent.find((f) => f.t === "event" && f.event?.type === "assistant.typing");
    expect(typingEvent?.threadId).toBe("t1");
    expect(typingEvent?.durable).toBeUndefined();

    const pong = framesFromAgent.find((f) => f.t === "pong");
    expect(pong).toBeTruthy();

    await mockHub.close();
  });

  it("processa frame message do hub via POST /ui/threads/:id/messages", async () => {
    const app = express();
    app.use(express.json());
    const posts = [];
    app.post("/ui/threads/:id/messages", requireSession, (req, res) => {
      posts.push({ threadId: req.params.id, body: req.body });
      return res.status(202).json({ ok: true, accepted: true });
    });
    const api = await listenApp(app);
    apiServer = api.server;

    const dispatchUiRequest = createUiHubDispatcher(api.baseUrl, { sessionToken: TOKEN });
    const mockHub = await listenWss();

    mockHub.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.t === "hello") {
          ws.send(JSON.stringify({ t: "ready", agent: { id: "tetos", name: "TetOS" }, devices: [] }));
          ws.send(
            JSON.stringify({
              t: "message",
              agentId: "tetos",
              threadId: "thread-hub",
              message: { id: "msg-u1", role: "user", text: "olá hub" },
              history: [],
              user: { id: "user-1" },
            }),
          );
        }
      });
    });

    hub = new HubAgentLink({
      config: { ...baseConfig, url: mockHub.url },
      dispatchUiRequest,
      uiBus: new UiEventBus(),
      onLog: () => {},
      onError: () => {},
    });
    hub.start();

    await vi.waitFor(() => {
      expect(posts.some((p) => p.threadId === "thread-hub" && p.body?.text === "olá hub")).toBe(true);
    });

    await mockHub.close();
  });
});

describe("startHubAgentLinkIfConfigured", () => {
  const prev = { ...process.env };

  beforeEach(() => {
    process.env = { ...prev };
  });

  afterEach(() => {
    process.env = prev;
  });

  it("não inicia sem variáveis", () => {
    delete process.env.TETOS_HUB_AGENT_URL;
    delete process.env.TETOS_HUB_AGENT_TOKEN;
    const link = startHubAgentLinkIfConfigured({
      uiBus: new UiEventBus(),
      dispatchBaseUrl: "http://127.0.0.1:9",
    });
    expect(link).toBeNull();
  });
});
