import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { createUiHubDispatcher } from "../../src/integrations/automate-hub/uiHubDispatch.js";
import { requireSession } from "../../src/infra/api/auth/sessionAuth.js";

const TOKEN = "tetos-dev-session";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe("createUiHubDispatcher", () => {
  it("bloqueia rotas fora de /ui/*", async () => {
    const dispatch = createUiHubDispatcher("http://127.0.0.1:9", { sessionToken: TOKEN });
    await expect(dispatch({ method: "GET", path: "/status" })).rejects.toThrow("/ui/*");
  });

  it("injeta Authorization do dono e executa handler", async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.get("/ui/echo-auth", requireSession, (req, res) => {
      res.json({ auth: req.headers.authorization });
    });
    app.post("/ui/echo-body", requireSession, (req, res) => {
      res.json({ body: req.body });
    });

    const { server, baseUrl } = await listen(app);
    try {
      const dispatch = createUiHubDispatcher(baseUrl, { sessionToken: TOKEN });
      const getRes = await dispatch({ method: "GET", path: "/ui/echo-auth" });
      expect(getRes.status).toBe(200);
      expect(JSON.parse(getRes.body).auth).toBe(`Bearer ${TOKEN}`);

      const postRes = await dispatch({
        method: "POST",
        path: "/ui/echo-body",
        body: { hello: "hub" },
      });
      expect(postRes.status).toBe(200);
      expect(JSON.parse(postRes.body).body).toEqual({ hello: "hub" });
    } finally {
      server.close();
    }
  });
});
