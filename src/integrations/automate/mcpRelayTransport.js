import { randomUUID } from "node:crypto";

/**
 * Transport MCP sobre frames WebSocket do gateway TetOS (t: rpc).
 */
export class McpRelayTransport {
  constructor(ws, { onNotification } = {}) {
    this.ws = ws;
    this.onNotification = onNotification;
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
    this._closed = false;
  }

  async start() {
    // Conexão já aberta pelo gateway.
  }

  async close() {
    this._closed = true;
    this.onclose?.();
  }

  async send(message) {
    if (this._closed || this.ws.readyState !== this.ws.OPEN) {
      throw new Error("WebSocket do relay não está aberto");
    }
    this.ws.send(JSON.stringify({ t: "rpc", payload: message }));
  }

  /** Chamado pelo DeviceGateway quando chega JSON-RPC do device. */
  deliverIncoming(message) {
    if (message?.method?.startsWith("notifications/")) {
      this.onNotification?.(message.method, message.params);
      return;
    }
    this.onmessage?.(message);
  }
}

let rpcIdCounter = 0;

export function nextMcpRpcId() {
  rpcIdCounter += 1;
  return `tetos-${Date.now()}-${rpcIdCounter}-${randomUUID().slice(0, 8)}`;
}
