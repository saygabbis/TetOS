import { appendFile } from "node:fs/promises";
import { WebSocketServer } from "ws";

const DEBUG_LOG_PATH =
  process.env.TETOS_DEBUG_LOG?.trim() ||
  "C:\\Users\\Administrator\\Desktop\\Kevin\\AutoMate\\.cursor\\debug-9049d4.log";

function agentDebugLog(payload) {
  const line = JSON.stringify({ sessionId: "9049d4", timestamp: Date.now(), ...payload });
  void appendFile(DEBUG_LOG_PATH, `${line}\n`).catch(() => undefined);
}
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { translateAutomateNotification, getProtocolVersion } from "./eventTranslator.js";
import { auditAutomateEnqueue } from "./auditLog.js";
import { checkRateLimit } from "./rateLimit.js";
import { McpRelayTransport, nextMcpRpcId } from "./mcpRelayTransport.js";

export class DeviceGateway {
  constructor({ deviceRegistry, uiBus }) {
    this.deviceRegistry = deviceRegistry;
    this.uiBus = uiBus;
    /** @type {Map<string, { ws: import('ws').WebSocket, mcp: Client, transport: McpRelayTransport }>} */
    this.sessions = new Map();
  }

  attach(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname !== "/device-link") {
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws);
      });
    });
    return wss;
  }

  isDeviceConnected(deviceId) {
    const session = this.sessions.get(deviceId);
    return Boolean(session?.ws && session.ws.readyState === session.ws.OPEN);
  }

  handleConnection(ws) {
    let deviceId = null;
    let transport = null;
    let mcpClient = null;

    const teardown = () => {
      if (deviceId) this.sessions.delete(deviceId);
      transport = null;
      mcpClient = null;
    };

    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(String(raw));
        if (frame.t === "hello") {
          if (frame.protocol !== getProtocolVersion()) {
            ws.send(JSON.stringify({ t: "denied", reason: "protocol incompatível" }));
            ws.close();
            return;
          }
          const auth = this.deviceRegistry.validate(frame.token, frame.deviceId);
          if (!auth.ok) {
            ws.send(JSON.stringify({ t: "denied", reason: auth.reason }));
            ws.close();
            return;
          }
          deviceId = frame.deviceId;
          const sessionId = `sess-${deviceId}-${Date.now()}`;
          transport = new McpRelayTransport(ws, {
            onNotification: (method, params) => {
              const events = translateAutomateNotification(method, params, { uiBus: this.uiBus });
              // #region agent log
              agentDebugLog({
                location: "deviceGateway.js:onNotification",
                message: "automate notification",
                hypothesisId: "B",
                data: {
                  method,
                  instructionId: params?.instructionId ?? null,
                  eventTypes: events.map((e) => e?.type),
                },
              });
              // #endregion
              for (const event of events) {
                if (
                  event?.type === "plan.started" &&
                  event.runId &&
                  !String(event.runId).startsWith("run-")
                ) {
                  continue;
                }
                this.uiBus.publish(event);
              }
            },
          });
          mcpClient = new Client({ name: "tetos-device-gateway", version: "0.1.0" });
          // AutoMate só processa RPC após o frame `ready`; enviar antes do initialize evita deadlock.
          ws.send(
            JSON.stringify({ t: "ready", sessionId, profile: frame.profile ?? "delegate" }),
          );
          void mcpClient
            .connect(transport)
            .then(() => {
              this.sessions.set(deviceId, { ws, mcp: mcpClient, transport });
            })
            .catch((err) => {
              console.error("[device-gateway] falha MCP initialize", err?.message ?? err);
              ws.send(JSON.stringify({ t: "denied", reason: "falha MCP initialize" }));
              ws.close();
            });
          return;
        }
        if (frame.t === "ping") {
          ws.send(JSON.stringify({ t: "pong" }));
          return;
        }
        if (frame.t === "rpc" && frame.payload && transport) {
          transport.deliverIncoming(frame.payload);
        }
      } catch {
        // frame inválido
      }
    });

    ws.on("close", teardown);
  }

  closeDevice(deviceId) {
    const session = this.sessions.get(deviceId);
    if (session?.ws) {
      session.ws.close();
    }
    this.sessions.delete(deviceId);
  }

  async callTool(deviceId, name, args) {
    const limit = checkRateLimit(`device:${deviceId}:enqueue`);
    if (!limit.ok) {
      throw new Error("Limite de taxa excedido");
    }
    const session = this.sessions.get(deviceId);
    if (!session?.mcp) throw new Error("Device offline");

    auditAutomateEnqueue({ deviceId, tool: name, args });

    const result = await session.mcp.callTool({ name, arguments: args });
    if (result?.isError) {
      const msg =
        Array.isArray(result.content) && result.content[0]?.text
          ? result.content[0].text
          : "erro MCP";
      throw new Error(msg);
    }
    return result;
  }

  /** Legado: RPC direto com id numérico (testes). */
  async callToolRaw(deviceId, name, args) {
    const ws = this.sessions.get(deviceId)?.ws;
    if (!ws) throw new Error("Device offline");
    const id = nextMcpRpcId();
    const payload = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };
    return new Promise((resolve, reject) => {
      const handler = (raw) => {
        try {
          const frame = JSON.parse(String(raw));
          if (frame.t === "rpc" && frame.payload?.id === id) {
            ws.off("message", handler);
            if (frame.payload.error) {
              reject(new Error(frame.payload.error.message ?? "RPC error"));
            } else {
              resolve(frame.payload.result);
            }
          }
        } catch {
          // ignore
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ t: "rpc", payload }));
      setTimeout(() => {
        ws.off("message", handler);
        reject(new Error("timeout RPC"));
      }, 120_000);
    });
  }
}
