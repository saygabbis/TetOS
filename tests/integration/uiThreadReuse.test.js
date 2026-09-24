import { describe, expect, it } from "vitest";
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

describe("UI threads reuse e rename", () => {
  it("POST reutiliza thread vazia e PATCH renomeia", async () => {
    const prevToken = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_THREADS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = DEV_TOKEN;
    const storePath = "./data/test-uiThreads-reuse.json";
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
          id: "thread-full",
          title: "Com mensagens",
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
      const create = await fetch(`${base}/ui/threads`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Nova conversa", reuseEmpty: true }),
      });
      expect(create.status).toBe(200);
      const created = await create.json();
      expect(created.reused).toBe(true);
      expect(created.thread.id).toBe("thread-empty");

      const patch = await fetch(`${base}/ui/threads/thread-empty`, {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Planejamento de viagem" }),
      });
      expect(patch.status).toBe(200);
      const renamed = await patch.json();
      expect(renamed.thread.title).toBe("Planejamento de viagem");
    } finally {
      server.close();
      if (prevToken === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
      else process.env.TETOS_UI_SESSION_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.TETOS_UI_THREADS_PATH;
      else process.env.TETOS_UI_THREADS_PATH = prevPath;
    }
  });
});
