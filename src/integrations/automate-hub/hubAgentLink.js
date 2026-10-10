import WebSocket from "ws";
import { readHubAgentConfig } from "./hubAgentConfig.js";

function parseJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function normalizeRpcHttpRequest(frame) {
  const nested = frame.http ?? frame.request ?? frame.agent_rpc ?? null;
  const source = nested && typeof nested === "object" ? nested : frame;
  const method = source.method ?? frame.method;
  const path = source.path ?? source.url ?? frame.path ?? frame.url;
  if (!method || !path) {
    return null;
  }
  return {
    method: String(method),
    path: String(path),
    headers: source.headers && typeof source.headers === "object" ? source.headers : {},
    body: source.body ?? frame.body,
  };
}

export class HubAgentLink {
  constructor({
    config,
    dispatchUiRequest,
    uiBus,
    WebSocketImpl = WebSocket,
    onLog = console.log,
    onError = console.error,
  }) {
    this.config = config;
    this.dispatchUiRequest = dispatchUiRequest;
    this.uiBus = uiBus;
    this.WebSocketImpl = WebSocketImpl;
    this.onLog = onLog;
    this.onError = onError;

    this.ws = null;
    this.authenticated = false;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.streamUnsubscribe = null;
    this.messageChain = Promise.resolve();
  }

  start() {
    if (this.stopped) return;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.detachStream();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  clearTimers() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.clearTimers();
    const min = this.config.reconnectMinMs;
    const max = this.config.reconnectMaxMs;
    const attempt = Math.min(this.reconnectAttempt, 12);
    const delay = Math.min(max, min * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay + jitter);
  }

  attachStream() {
    if (!this.uiBus || this.streamUnsubscribe) return;
    const handler = (envelope) => {
      this.send({ t: "event", id: envelope.id, event: envelope.event });
    };
    this.uiBus.on("event", handler);
    this.streamUnsubscribe = () => this.uiBus.off("event", handler);
  }

  detachStream() {
    if (this.streamUnsubscribe) {
      this.streamUnsubscribe();
      this.streamUnsubscribe = null;
    }
  }

  send(frame) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN || !this.authenticated) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.onError("[hub-agent] falha ao enviar frame", error?.message ?? error);
      return false;
    }
  }

  async connect() {
    if (this.stopped) return;
    this.clearTimers();
    this.authenticated = false;
    this.detachStream();

    const ws = new this.WebSocketImpl(this.config.url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      ws.send(
        JSON.stringify({
          t: "hello",
          protocol: this.config.protocol,
          agentId: this.config.agentId,
          token: this.config.token,
          capabilities: this.config.capabilities,
        }),
      );
    });

    ws.on("message", (raw) => {
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(raw))
        .catch((error) => {
          this.onError("[hub-agent] falha ao processar frame", error?.message ?? error);
        });
    });

    ws.on("close", () => {
      this.authenticated = false;
      this.detachStream();
      this.ws = null;
      this.reconnectAttempt += 1;
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      this.onError("[hub-agent] websocket erro", error?.message ?? error);
    });
  }

  onHelloAccepted(frame) {
    this.authenticated = true;
    this.onLog(
      `[hub-agent] conectado como ${this.config.agentId}` +
        (frame?.sessionId ? ` (sessão ${frame.sessionId})` : ""),
    );
    this.attachStream();
    this.heartbeatTimer = setInterval(() => {
      this.send({ t: "ping" });
    }, this.config.heartbeatMs);
  }

  async handleMessage(raw) {
    const frame = parseJson(raw);
    if (!frame || typeof frame.t !== "string") {
      return;
    }

    switch (frame.t) {
      case "hello_ok":
      case "welcome":
      case "ready":
        this.onHelloAccepted(frame);
        return;
      case "denied":
        this.onError(`[hub-agent] conexão negada: ${frame.reason ?? "motivo desconhecido"}`);
        this.ws?.close();
        return;
      case "ping":
        this.send({ t: "pong" });
        return;
      case "pong":
        return;
      case "rpc":
      case "agent_rpc":
        await this.handleRpc(frame);
        return;
      case "chat":
        await this.handleChat(frame);
        return;
      default: {
        const unknownType = frame.t;
        void unknownType;
        return;
      }
    }
  }

  async handleRpc(frame) {
    const replyType = frame.t === "agent_rpc" ? "agent_rpc" : "rpc";
    const id = frame.id ?? frame.requestId;
    const httpReq = normalizeRpcHttpRequest(frame);
    if (!id || !httpReq) {
      this.send({
        t: replyType,
        id,
        ok: false,
        error: "requisição RPC inválida",
      });
      return;
    }

    try {
      const response = await this.dispatchUiRequest(httpReq);
      let body = response.body;
      const contentType = response.headers["content-type"] ?? "";
      if (contentType.includes("application/json") && typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          // mantém string
        }
      }
      this.send({
        t: replyType,
        id,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        headers: response.headers,
        body,
      });
    } catch (error) {
      this.send({
        t: replyType,
        id,
        ok: false,
        status: 500,
        error: error?.message ?? "erro interno",
      });
    }
  }

  async handleChat(frame) {
    const id = frame.id ?? frame.requestId;
    const text = frame.text ?? frame.message ?? frame.content;
    const threadId = frame.threadId ?? frame.thread_id ?? "hub-default";

    if (!id || !text || typeof text !== "string") {
      this.send({ t: "chat", id, ok: false, error: "chat inválido" });
      return;
    }

    try {
      const response = await this.dispatchUiRequest({
        method: "POST",
        path: `/ui/threads/${encodeURIComponent(threadId)}/messages`,
        body: { text },
      });
      let payload = response.body;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          payload = { raw: payload };
        }
      }
      this.send({
        t: "chat",
        id,
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        threadId,
        result: payload,
      });
    } catch (error) {
      this.send({
        t: "chat",
        id,
        ok: false,
        error: error?.message ?? "erro ao processar chat",
      });
    }
  }
}

export function createHubAgentLink(deps) {
  const config = deps.config ?? readHubAgentConfig();
  if (!config) return null;
  const link = new HubAgentLink({ ...deps, config });
  link.start();
  return link;
}
