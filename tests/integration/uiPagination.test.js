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

describe("UI pagination", () => {
  it("GET /ui/threads/:id/messages pagina com before e hasMore", async () => {
    const prevToken = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_THREADS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = DEV_TOKEN;
    const storePath = "./data/test-uiThreads-pagination.json";
    process.env.TETOS_UI_THREADS_PATH = storePath;

    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      text: `mensagem ${i}`,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
    }));

    writeJson(storePath, {
      threads: [
        {
          id: "thread-pag",
          title: "Paginação",
          updatedAt: "2025-06-01T12:00:00.000Z",
          messages,
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
      const first = await fetch(`${base}/ui/threads/thread-pag/messages?limit=10`, {
        headers: authHeaders(),
      });
      expect(first.status).toBe(200);
      const body1 = await first.json();
      expect(body1.messages).toHaveLength(10);
      expect(body1.messages[0].id).toBe("m-40");
      expect(body1.messages[9].id).toBe("m-49");
      expect(body1.hasMore).toBe(true);

      const oldestId = body1.messages[0].id;
      const older = await fetch(
        `${base}/ui/threads/thread-pag/messages?limit=10&before=${oldestId}`,
        { headers: authHeaders() },
      );
      const body2 = await older.json();
      expect(body2.messages).toHaveLength(10);
      expect(body2.messages[9].id).toBe("m-39");
      expect(body2.messages[0].id).toBe("m-30");
    } finally {
      server.close();
      if (prevToken === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
      else process.env.TETOS_UI_SESSION_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.TETOS_UI_THREADS_PATH;
      else process.env.TETOS_UI_THREADS_PATH = prevPath;
    }
  });
});
