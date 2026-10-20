import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "bridge-"));
process.env.TETOS_WHATSAPP_OUTBOX_PATH = join(dir, "outbox.json");

const { registerWhatsAppAutomateBridge } = await import("../../src/integrations/automate/whatsappBridge.js");
const { reportAutomateOutcome } = await import("../../src/integrations/automate/automateRunContext.js");
const { takePendingOutbox } = await import("../../src/integrations/whatsapp/conversation/outbox.js");

let server;
let base;
let online = true;
const calls = [];
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerWhatsAppAutomateBridge(app, {
    apiToken: "tok",
    deviceGateway: { isDeviceConnected: () => online },
    automateClient: { enqueue: async (intent, _d, meta) => (calls.push({ intent, meta }), { content: [{ text: JSON.stringify({ id: "instr-1" }) }] }) }
  });
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body, token = "tok") =>
  fetch(`${base}/automate/whatsapp/run`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

describe("AutoMate pelo WhatsApp", () => {
  it("exige token", async () => {
    expect((await post({ intent: "x", jid: "1@s.whatsapp.net" }, "errado")).status).toBe(401);
  });
  it("PC offline → 409", async () => {
    online = false;
    expect((await post({ intent: "abrir spotify", jid: "1@s.whatsapp.net" })).status).toBe(409);
    online = true;
  });
  it("enfileira e devolve o resultado pra caixa de saída do zap", async () => {
    const res = await post({ intent: "abrir spotify", jid: "5516@s.whatsapp.net" });
    expect(res.status).toBe(200);
    const { runId } = await res.json();
    expect(calls.at(-1)).toMatchObject({ intent: "abrir spotify", meta: { threadId: "wa:5516@s.whatsapp.net", runId } });
    reportAutomateOutcome({ runId, threadId: "wa:5516@s.whatsapp.net", status: "completed", output: "Spotify aberto." });
    const [item] = takePendingOutbox(process.env.TETOS_WHATSAPP_OUTBOX_PATH);
    expect(item).toMatchObject({ to: "5516@s.whatsapp.net", kind: "automate_outcome", payload: { status: "completed", output: "Spotify aberto.", intent: "abrir spotify" } });
  });
});
