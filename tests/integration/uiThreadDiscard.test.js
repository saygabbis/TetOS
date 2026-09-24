import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { writeJson, readJson } from "../../src/infra/utils/fileStore.js";
import { registerUiThreadRoutes } from "../../src/infra/api/routes/uiThreads.js";
import { DeviceRegistry } from "../../src/infra/api/auth/deviceRegistry.js";
import { DeviceGateway } from "../../src/integrations/automate/deviceGateway.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";

const DEV_TOKEN = "tetos-dev-session";

function authHeaders() {
  return { Authorization: `Bearer ${DEV_TOKEN}` };
}

describe("UI threads discard vazias", () => {
  it("GET não lista vazias e DELETE remove vazia", async () => {
    const prevToken = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_THREADS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = DEV_TOKEN;
    const storePath = "./data/test-uiThreads-discard.json";
    process.env.TETOS_UI_THREADS_PATH = storePath;

    writeJson(storePath, {
      threads: [
        {
          id: "thread-empty",
          title: "Nova conversa",
          updatedAt: "2025-06-02T12:00:00.000Z",
          messages: [],
        },
        {
          id: "thread-ok",
          title: "Com texto",
          updatedAt: "2025-06-01T12:00:00.000Z",
          messages: [{ id: "m-1", role: "user", text: "oi", createdAt: "2025-06-01T12:00:00.000Z" }],
        },
      ],
    });

    const app = express();
    app.use(express.json());
    const uiBus = new UiEventBus();
    const deviceRegistry = new DeviceRegistry();
    const deviceGateway = new DeviceGateway({ deviceRegistry, uiBus });
    const automateClient = { answer: async () => {}, interrupt: async () => {} };
    registerUiThreadRoutes(app, {}, uiBus, automateClient, deviceRegistry, deviceGateway);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const list = await fetch(`${base}/ui/threads`, { headers: authHeaders() });
      const body = await list.json();
      expect(body.threads.some((t) => t.id === "thread-empty")).toBe(false);
      expect(body.threads.some((t) => t.id === "thread-ok")).toBe(true);

      const stored = readJson(storePath, { threads: [] });
      expect(stored.threads.some((t) => t.id === "thread-empty")).toBe(false);

      const del = await fetch(`${base}/ui/threads/thread-ok`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(del.status).toBe(400);
    } finally {
      server.close();
      if (prevToken === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
      else process.env.TETOS_UI_SESSION_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.TETOS_UI_THREADS_PATH;
      else process.env.TETOS_UI_THREADS_PATH = prevPath;
    }
  });
});
