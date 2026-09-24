import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import { attachUiCors } from "../../src/infra/api/middleware/uiCors.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

describe("uiCors", () => {
  it("OPTIONS /ui/threads devolve cabeçalhos CORS para localhost:5173", async () => {
    const app = express();
    attachUiCors(app);
    app.get("/ui/threads", (_req, res) => res.json({ threads: [] }));

    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ui/threads`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
        "authorization",
      );
    } finally {
      server.close();
    }
  });
});
