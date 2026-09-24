import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { writeJson } from "../../src/infra/utils/fileStore.js";
import { registerUiThreadRoutes } from "../../src/infra/api/routes/uiThreads.js";
import { DeviceRegistry } from "../../src/infra/api/auth/deviceRegistry.js";
import { DeviceGateway } from "../../src/integrations/automate/deviceGateway.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";
import { bindRunToThread } from "../../src/integrations/automate/automateRunContext.js";

const DEV_TOKEN = "tetos-dev-session";

function authHeaders() {
  return { Authorization: `Bearer ${DEV_TOKEN}` };
}

describe("UI automate chat history", () => {
  it("persiste plan.step e run.status em thread.messages", async () => {
    const prevToken = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_THREADS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = DEV_TOKEN;
    const storePath = "./data/test-uiThreads-automate-history.json";
    process.env.TETOS_UI_THREADS_PATH = storePath;

    writeJson(storePath, {
      threads: [
        {
          id: "thread-auto",
          title: "Chat",
          updatedAt: "2025-06-02T12:00:00.000Z",
          messages: [{ id: "u-1", role: "user", text: "abre o chrome", createdAt: "2025-06-02T12:00:00.000Z" }],
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

    const runId = "run-test-1";
    bindRunToThread(runId, "thread-auto");
    uiBus.publish({
      type: "plan.started",
      runId,
      threadId: "thread-auto",
      title: "Plano",
    });
    uiBus.publish({
      type: "plan.step",
      runId,
      step: {
        id: "browser_navigate-1",
        index: 0,
        tool: "browser_navigate",
        title: "browser_navigate",
        state: "done",
      },
    });
    uiBus.publish({ type: "run.status", runId, status: "completed" });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${base}/ui/threads/thread-auto/messages?limit=50`, {
        headers: authHeaders(),
      });
      const body = await res.json();
      const texts = body.messages.map((m) => m.text);
      expect(texts.some((t) => t.includes("browser_navigate"))).toBe(true);
      expect(texts.some((t) => t.includes("concluído"))).toBe(true);
      const stepMsg = body.messages.find((m) => m.meta?.automate?.kind === "step");
      expect(stepMsg?.meta?.automate?.step?.tool).toBe("browser_navigate");
    } finally {
      server.close();
      if (prevToken === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
      else process.env.TETOS_UI_SESSION_TOKEN = prevToken;
      if (prevPath === undefined) delete process.env.TETOS_UI_THREADS_PATH;
      else process.env.TETOS_UI_THREADS_PATH = prevPath;
    }
  });
});
