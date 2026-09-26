import { describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import { writeJson } from "../../src/infra/utils/fileStore.js";
import { registerUiThreadRoutes } from "../../src/infra/api/routes/uiThreads.js";
import { DeviceRegistry } from "../../src/infra/api/auth/deviceRegistry.js";
import { DeviceGateway } from "../../src/integrations/automate/deviceGateway.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";

const DEV_TOKEN = "tetos-dev-session";

function authHeaders() {
  return { Authorization: `Bearer ${DEV_TOKEN}` };
}

describe("UI skillRefs", () => {
  it("encaminha skillRefs no modo automate para automate_enqueue", async () => {
    const prevToken = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_THREADS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = DEV_TOKEN;
    const storePath = "./data/test-uiThreads-skillrefs.json";
    process.env.TETOS_UI_THREADS_PATH = storePath;

    writeJson(storePath, {
      threads: [
        {
          id: "thread-skills",
          title: "Chat",
          updatedAt: "2025-06-02T12:00:00.000Z",
          messages: [],
        },
      ],
    });

    const enqueue = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ id: "instr-1" }) }],
    }));
    const automateClient = { enqueue, answer: async () => {}, interrupt: async () => {} };

    const app = express();
    app.use(express.json());
    const uiBus = new UiEventBus();
    const deviceRegistry = new DeviceRegistry();
    const deviceGateway = new DeviceGateway({ deviceRegistry, uiBus });
    registerUiThreadRoutes(app, {}, uiBus, automateClient, deviceRegistry, deviceGateway);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/ui/threads/thread-skills/messages`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "abre o youtube",
          mode: "automate",
          skillRefs: ["abre-o-youtube"],
        }),
      });
      expect(res.status).toBe(200);
      expect(enqueue).toHaveBeenCalledTimes(1);
      const [, , meta] = enqueue.mock.calls[0];
      expect(meta.skillNames).toEqual(["abre-o-youtube"]);
      expect(String(enqueue.mock.calls[0][0])).toContain("abre o youtube");
    } finally {
      server.close();
      if (prevToken === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
      else process.env.TETOS_UI_SESSION_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.TETOS_UI_THREADS_PATH;
      else process.env.TETOS_UI_THREADS_PATH = prevPath;
    }
  });

  it("detecta @automate no texto e enfileira sem mode no body", async () => {
    const prevToken = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_THREADS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = DEV_TOKEN;
    const storePath = "./data/test-uiThreads-automate-mention.json";
    process.env.TETOS_UI_THREADS_PATH = storePath;

    writeJson(storePath, {
      threads: [
        {
          id: "thread-at",
          title: "Chat",
          updatedAt: "2025-06-02T12:00:00.000Z",
          messages: [],
        },
      ],
    });

    const enqueue = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ id: "instr-2" }) }],
    }));
    const automateClient = { enqueue, answer: async () => {}, interrupt: async () => {} };

    const app = express();
    app.use(express.json());
    const uiBus = new UiEventBus();
    const deviceRegistry = new DeviceRegistry();
    const deviceGateway = new DeviceGateway({ deviceRegistry, uiBus });
    registerUiThreadRoutes(app, {}, uiBus, automateClient, deviceRegistry, deviceGateway);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/ui/threads/thread-at/messages`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "por favor @automate abre o bloco de notas",
        }),
      });
      expect(res.status).toBe(200);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(String(enqueue.mock.calls[0][0])).toContain("abre o bloco de notas");
      expect(String(enqueue.mock.calls[0][0])).not.toContain("@automate");
    } finally {
      server.close();
      if (prevToken === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
      else process.env.TETOS_UI_SESSION_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.TETOS_UI_THREADS_PATH;
      else process.env.TETOS_UI_THREADS_PATH = prevPath;
    }
  });
});
