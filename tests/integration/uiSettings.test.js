import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { registerUiSettingsRoutes } from "../../src/infra/api/routes/uiSettings.js";
import { DeviceRegistry } from "../../src/infra/api/auth/deviceRegistry.js";
import { DeviceGateway } from "../../src/integrations/automate/deviceGateway.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";

const DEV_TOKEN = "tetos-dev-session";

function authHeaders() {
  return { Authorization: `Bearer ${DEV_TOKEN}` };
}

describe("UI settings routes", () => {
  it("GET/PATCH /ui/settings persiste campos graváveis", async () => {
    const prev = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_SETTINGS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = DEV_TOKEN;
    process.env.TETOS_UI_SETTINGS_PATH = "./data/test-uiSettings.json";

    const app = express();
    app.use(express.json());
    const uiBus = new UiEventBus();
    const deviceRegistry = new DeviceRegistry();
    const deviceGateway = new DeviceGateway({ deviceRegistry, uiBus });
    registerUiSettingsRoutes(app, deviceRegistry, deviceGateway);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const getRes = await fetch(`${base}/ui/settings`, { headers: authHeaders() });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.settings.locale).toBeDefined();
      expect(getBody.settings.llmModel).toBeDefined();

      const patchRes = await fetch(`${base}/ui/settings`, {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ memoryPrivacy: "strict", theme: "dark" }),
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json();
      expect(patched.settings.memoryPrivacy).toBe("strict");
      expect(patched.settings.theme).toBe("dark");
    } finally {
      server.close();
      if (prev === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
      else process.env.TETOS_UI_SESSION_TOKEN = prev;
      if (prevPath === undefined) delete process.env.TETOS_UI_SETTINGS_PATH;
      else process.env.TETOS_UI_SETTINGS_PATH = prevPath;
    }
  });
});
