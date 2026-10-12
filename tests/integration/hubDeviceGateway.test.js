import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import { WebSocketServer } from "ws";
import { HubAgentLink } from "../../src/integrations/automate-hub/hubAgentLink.js";
import { HubDeviceGateway, CompositeDeviceGateway } from "../../src/integrations/automate-hub/hubDeviceGateway.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";

const baseConfig = {
  agentId: "tetos",
  token: "secret",
  capabilities: ["chat", "rpc"],
  contextMethods: ["notifications/automate/"],
  protocol: 1,
  heartbeatMs: 60_000,
  reconnectMinMs: 50,
  reconnectMaxMs: 100,
};

async function startHub(onFrame) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.t === "hello") {
        ws.send(JSON.stringify({ t: "ready", agent: { name: "TetOS" }, devices: [{ id: "dv_1", online: true, profile: "delegate" }] }));
        return;
      }
      onFrame(frame, (f) => ws.send(JSON.stringify(f)));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, wss, url: `ws://127.0.0.1:${server.address().port}` };
}

async function waitReady(link) {
  for (let i = 0; i < 100 && !link.isReady(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(link.isReady()).toBe(true);
}

describe("HubDeviceGateway", () => {
  let link;
  let hub;
  afterEach(async () => {
    link?.stop();
    if (hub) {
      for (const c of hub.wss.clients) c.close();
      await new Promise((r) => hub.wss.close(() => hub.server.close(r)));
    }
    hub = null;
  });

  it("enfileira via frame call no PC online do hub", async () => {
    const calls = [];
    hub = await startHub((frame, reply) => {
      calls.push(frame);
      if (frame.t === "call") {
        reply({ t: "result", id: frame.id, deviceId: frame.deviceId, result: { content: [{ type: "text", text: '{"id":"instr-1"}' }] } });
      }
    });
    link = new HubAgentLink({ config: { ...baseConfig, url: hub.url }, dispatchUiRequest: async () => ({}), uiBus: new UiEventBus(), onLog: () => {}, onError: () => {} });
    link.start();
    await waitReady(link);

    const gw = new HubDeviceGateway({ getLink: () => link });
    expect(gw.isDeviceConnected("default-device")).toBe(true); // cai no único PC online
    const result = await gw.callTool("default-device", "automate_enqueue", { text: "abre o bloco de notas" });
    expect(result.content[0].text).toContain("instr-1");
    expect(calls[0]).toMatchObject({ t: "call", deviceId: "dv_1", tool: "automate_enqueue", args: { text: "abre o bloco de notas" } });
  });

  it("propaga erro do hub com code", async () => {
    hub = await startHub((frame, reply) => {
      reply({ t: "error", id: frame.id, code: "confirmation_denied", message: "O usuário não aprovou" });
    });
    link = new HubAgentLink({ config: { ...baseConfig, url: hub.url }, dispatchUiRequest: async () => ({}), uiBus: new UiEventBus(), onLog: () => {}, onError: () => {} });
    link.start();
    await waitReady(link);
    const gw = new HubDeviceGateway({ getLink: () => link });
    await expect(gw.callTool("dv_1", "automate_enqueue", {})).rejects.toMatchObject({ code: "confirmation_denied" });
  });

  it("sem hub conectado: Device offline / Hub offline", async () => {
    const gw = new HubDeviceGateway({ getLink: () => null });
    expect(gw.isDeviceConnected("x")).toBe(false);
    await expect(gw.callTool("x", "automate_enqueue", {})).rejects.toThrow("Hub offline");
  });

  it("composite prefere o gateway local quando o PC está ligado nele", async () => {
    const seen = [];
    const local = { attach() {}, closeDevice() {}, isDeviceConnected: (d) => d === "loc", callTool: async () => (seen.push("local"), "L") };
    const hubGw = { isDeviceConnected: () => true, callTool: async () => (seen.push("hub"), "H") };
    const c = new CompositeDeviceGateway({ local, hub: hubGw });
    expect(await c.callTool("loc", "t", {})).toBe("L");
    expect(await c.callTool("dv_1", "t", {})).toBe("H");
    expect(seen).toEqual(["local", "hub"]);
  });
});
