import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { readHubAgentConfig } from "../../src/integrations/automate-hub/hubAgentConfig.js";
import { createUiHubDispatcher } from "../../src/integrations/automate-hub/uiHubDispatch.js";
import { HubAgentLink } from "../../src/integrations/automate-hub/hubAgentLink.js";
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

describe("readHubAgentConfig", () => {
  it("retorna null sem URL ou token", () => {
    expect(readHubAgentConfig({})).toBeNull();
    expect(readHubAgentConfig({ TETOS_HUB_AGENT_URL: "ws://x" })).toBeNull();
    expect(readHubAgentConfig({ TETOS_HUB_AGENT_TOKEN: "t" })).toBeNull();
  });

  it("aplica defaults de id e capabilities", () => {
    const cfg = readHubAgentConfig({
      TETOS_HUB_AGENT_URL: "ws://hub/agent-link",
      TETOS_HUB_AGENT_TOKEN: "secret",
    });
    expect(cfg.agentId).toBe("tetos");
    expect(cfg.capabilities).toEqual(["chat", "rpc"]);
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

  it("envia hello, responde RPC /ui/* e encaminha eventos do stream", async () => {
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
          ws.send(JSON.stringify({ t: "hello_ok", sessionId: "sess-test" }));
          ws.send(JSON.stringify({ t: "ping" }));
          ws.send(
            JSON.stringify({
              t: "agent_rpc",
              id: "req-1",
              method: "GET",
              path: "/ui/ping",
            }),
          );
          return;
        }
      });
    });

    hub = new HubAgentLink({
      config: {
        url: mockHub.url,
        agentId: "tetos",
        token: "secret",
        capabilities: ["chat", "rpc"],
        protocol: 1,
        heartbeatMs: 60_000,
        reconnectMinMs: 50,
        reconnectMaxMs: 100,
      },
      dispatchUiRequest,
      uiBus,
      onLog: () => {},
      onError: () => {},
    });
    hub.start();

    await vi.waitFor(() => {
      expect(framesFromAgent.some((f) => f.t === "hello" && f.agentId === "tetos")).toBe(true);
      expect(framesFromAgent.some((f) => f.t === "agent_rpc" && f.id === "req-1" && f.body)).toBe(
        true,
      );
    });

    const rpcReply = framesFromAgent.find((f) => f.t === "agent_rpc" && f.id === "req-1" && f.body);
    expect(rpcReply.ok).toBe(true);
    expect(rpcReply.body).toEqual({ ok: true });

    uiBus.publish({ type: "assistant.typing", threadId: "t1", isTyping: true });
    await vi.waitFor(() => {
      expect(framesFromAgent.some((f) => f.t === "event" && f.event?.type === "assistant.typing")).toBe(
        true,
      );
    });

    const pong = framesFromAgent.find((f) => f.t === "pong");
    expect(pong).toBeTruthy();

    await mockHub.close();
  });

  it("processa chat via POST /ui/threads/:id/messages", async () => {
    const app = express();
    app.use(express.json());
    app.post("/ui/threads/:id/messages", requireSession, (req, res) => {
      return res.status(202).json({ accepted: true, threadId: req.params.id, text: req.body?.text });
    });
    const api = await listenApp(app);
    apiServer = api.server;

    const dispatchUiRequest = createUiHubDispatcher(api.baseUrl, { sessionToken: TOKEN });
    const mockHub = await listenWss();
    const replies = [];

    mockHub.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.t === "hello") {
          ws.send(JSON.stringify({ t: "hello_ok" }));
          ws.send(
            JSON.stringify({
              t: "chat",
              id: "chat-1",
              threadId: "thread-hub",
              text: "olá hub",
            }),
          );
        }
        if (frame.t === "chat") {
          replies.push(frame);
        }
      });
    });

    hub = new HubAgentLink({
      config: {
        url: mockHub.url,
        agentId: "tetos",
        token: "secret",
        capabilities: ["chat", "rpc"],
        protocol: 1,
        heartbeatMs: 60_000,
        reconnectMinMs: 50,
        reconnectMaxMs: 100,
      },
      dispatchUiRequest,
      uiBus: new UiEventBus(),
      onLog: () => {},
      onError: () => {},
    });
    hub.start();

    await vi.waitFor(() => {
      expect(replies.some((f) => f.id === "chat-1" && f.ok === true)).toBe(true);
    });

    const chatReply = replies.find((f) => f.id === "chat-1");
    expect(chatReply.result?.text).toBe("olá hub");

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
