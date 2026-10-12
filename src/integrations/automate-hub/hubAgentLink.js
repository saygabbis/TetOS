import WebSocket from "ws";
import { readHubAgentConfig } from "./hubAgentConfig.js";
import { translateAutomateNotification } from "../automate/eventTranslator.js";
import { setAutomateDevicePresence, setAutomateDevices } from "../automate/automateCapabilities.js";

function parseJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** Eventos que o hub persiste (`durable: true`) para retomada. */
export function isDurableHubEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.type === "permission.request" || event.type === "control.request") return true;
  if (event.type === "run.status" && (event.status === "completed" || event.status === "failed")) {
    return true;
  }
  return false;
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
    /** Threads criadas/roteadas pelo hub (`t:"message"`); demais usam `t:"event"` para o app. */
    this.hubChatThreadIds = new Set();
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this.pending = new Map();
    this.requestSeq = 0;
    /** @type {Map<string, { id: string, online: boolean, profile?: string }>} */
    this.devices = new Map();
    this.requestTimeoutMs = config.requestTimeoutMs ?? 130_000;
  }

  isHubChatThread(threadId) {
    return typeof threadId === "string" && threadId.length > 0 && this.hubChatThreadIds.has(threadId);
  }

  isReady() {
    return Boolean(this.ws && this.ws.readyState === this.ws.OPEN && this.authenticated);
  }

  /** PCs do usuário conhecidos pelo hub (via `ready`, `presence` e `devices`). */
  listDevices() {
    return [...this.devices.values()];
  }

  /** Envia um frame com `id` e aguarda `result`/`error`/`devices`/`tools` do hub. */
  request(frame, timeoutMs = this.requestTimeoutMs) {
    if (!this.isReady()) {
      return Promise.reject(new Error("Hub offline"));
    }
    const id = `tetos-${Date.now()}-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout aguardando o hub"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...frame, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Hub offline"));
      }
    });
  }

  settleRequest(frame) {
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.t === "error") {
      const err = new Error(frame.message ?? "erro do hub");
      err.code = frame.code;
      entry.reject(err);
    } else {
      entry.resolve(frame);
    }
  }

  rejectAllPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  setDevices(list) {
    this.devices.clear();
    // A Teto sabe quais PCs estão ligados e o que cada um faz (sistema, perfil, se tem tela).
    setAutomateDevices(list);
    if (!Array.isArray(list)) return;
    for (const d of list) {
      if (d && typeof d.id === "string") {
        this.devices.set(d.id, { id: d.id, online: d.online !== false, profile: d.profile });
      }
    }
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
      this.forwardUiEnvelope(envelope);
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

  forwardUiEnvelope(envelope) {
    const event = envelope?.event;
    if (!event || typeof event !== "object") return;

    const threadId = typeof event.threadId === "string" ? event.threadId : undefined;

    if (event.type === "message.final" && event.message?.role === "assistant") {
      if (this.isHubChatThread(threadId)) {
        this.send({
          t: "message",
          threadId,
          message: {
            id: event.message.id,
            role: "assistant",
            text: event.message.text ?? "",
            ...(event.message.meta ? { meta: event.message.meta } : {}),
            final: true,
          },
        });
        return;
      }
      this.send({
        t: "event",
        ...(threadId ? { threadId } : {}),
        event,
        durable: true,
      });
      return;
    }

    const frame = {
      t: "event",
      ...(threadId ? { threadId } : {}),
      event,
    };
    if (isDurableHubEvent(event)) {
      frame.durable = true;
    }
    this.send(frame);
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

  sendRpcResult(rpcId, { status, headers, body, bodyEncoding = "utf8" }) {
    return this.send({
      t: "rpc_result",
      rpcId,
      status,
      headers,
      body: body ?? null,
      bodyEncoding: bodyEncoding === "base64" ? "base64" : "utf8",
    });
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
          context: { methods: this.config.contextMethods },
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
      this.rejectAllPending("Hub desconectado");
      this.devices.clear();
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
    this.setDevices(frame?.devices);
    const name = frame?.agent?.name ?? this.config.agentId;
    this.onLog(`[hub-agent] conectado como ${name} (${this.config.agentId})`);
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
        await this.handleRpc(frame);
        return;
      case "message":
        await this.handleHubMessage(frame);
        return;
      case "cancel":
        this.handleCancel(frame);
        return;
      case "ctx":
        this.handleCtx(frame);
        return;
      case "presence":
        this.handlePresence(frame);
        return;
      case "result":
      case "error":
      case "devices":
      case "tools":
        if (frame.t === "devices") this.setDevices(frame.devices);
        this.settleRequest(frame);
        return;
      default: {
        const unknownType = frame.t;
        void unknownType;
        return;
      }
    }
  }

  async handleRpc(frame) {
    const rpcId = frame.rpcId;
    if (!rpcId) return;

    const method = frame.method;
    const path = frame.path;
    if (!method || !path) {
      this.sendRpcResult(rpcId, {
        status: 400,
        headers: {},
        body: JSON.stringify({ error: "requisição RPC inválida" }),
        bodyEncoding: "utf8",
      });
      return;
    }

    try {
      const response = await this.dispatchUiRequest({
        method: String(method),
        path: String(path),
        headers: frame.headers && typeof frame.headers === "object" ? frame.headers : {},
        body: frame.body,
        bodyEncoding: frame.bodyEncoding,
      });
      this.sendRpcResult(rpcId, {
        status: response.status,
        headers: response.headers,
        body: response.body,
        bodyEncoding: response.bodyEncoding ?? "utf8",
      });
    } catch (error) {
      const status = error?.message?.includes("/ui/devices") ? 403 : 502;
      this.sendRpcResult(rpcId, {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: error?.message ?? "erro interno" }),
        bodyEncoding: "utf8",
      });
    }
  }

  async handleHubMessage(frame) {
    const threadId = typeof frame.threadId === "string" ? frame.threadId : "";
    const raw = frame.message;
    const text = typeof raw?.text === "string" ? raw.text : "";
    const attachments = raw?.meta?.attachments;
    // Mensagem a que o usuário respondeu no app (a IA precisa saber o que ele está referenciando).
    const replyTo = raw?.meta?.replyTo && typeof raw.meta.replyTo === "object" ? raw.meta.replyTo : null;

    if (!threadId || (!text.trim() && !attachments?.length)) {
      return;
    }

    this.hubChatThreadIds.add(threadId);

    try {
      await this.dispatchUiRequest({
        method: "POST",
        path: `/ui/threads/${encodeURIComponent(threadId)}/messages`,
        body: {
          text,
          ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
          ...(replyTo ? { replyTo } : {}),
          ...(Array.isArray(frame.runs) && frame.runs.length ? { runs: frame.runs } : {}),
          ...(Array.isArray(frame.activeRuns) && frame.activeRuns.length ? { activeRuns: frame.activeRuns } : {}),
        },
      });
    } catch (error) {
      this.onError("[hub-agent] falha ao processar message do hub", error?.message ?? error);
    }
  }

  handleCancel(frame) {
    const threadId = typeof frame.threadId === "string" ? frame.threadId : "";
    if (!threadId) return;
    this.uiBus?.publish({
      type: "run.status",
      threadId,
      status: "cancelled",
      runId: `hub-cancel-${Date.now()}`,
    });
  }

  handleCtx(frame) {
    const method = typeof frame.method === "string" ? frame.method : "";
    if (!method) return;
    const events = translateAutomateNotification(method, frame.params ?? {}, { uiBus: this.uiBus });
    for (const event of events) {
      this.uiBus?.publish(event);
    }
  }

  handlePresence(frame) {
    const deviceId = typeof frame.deviceId === "string" ? frame.deviceId : "";
    if (!deviceId) return;
    const known = this.devices.get(deviceId);
    this.devices.set(deviceId, { ...(known ?? { id: deviceId }), id: deviceId, online: Boolean(frame.online) });
    setAutomateDevicePresence(deviceId, frame.online);
    this.uiBus?.publish({
      type: "device.presence",
      deviceId,
      online: Boolean(frame.online),
    });
  }
}

export function createHubAgentLink(deps) {
  const config = deps.config ?? readHubAgentConfig();
  if (!config) return null;
  const link = new HubAgentLink({ ...deps, config });
  link.start();
  return link;
}
