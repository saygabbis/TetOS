import { WebSocketServer } from "ws";
import { validateStreamSessionToken } from "../auth/sessionAuth.js";

const AUTH_TIMEOUT_MS = 10_000;

export function attachUiStream(server, uiBus) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  uiBus.on("event", (envelope) => {
    const msg = JSON.stringify(envelope);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN && ws.authenticated) {
        ws.send(msg);
      }
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/stream") {
      return;
    }

    const headerAuth = req.headers.authorization ?? "";
    const bearer = headerAuth.startsWith("Bearer ") ? headerAuth.slice(7) : "";
    const queryToken = url.searchParams.get("token") ?? "";
    const preAuthToken = bearer || queryToken;

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.authenticated = false;

      if (preAuthToken && validateStreamSessionToken(preAuthToken)) {
        ws.authenticated = true;
        clients.add(ws);
        ws.on("close", () => clients.delete(ws));
        const lastEventId = Number(url.searchParams.get("lastEventId") ?? "0");
        if (lastEventId > 0) {
          ws.send(
            JSON.stringify({
              id: lastEventId,
              event: { type: "presence", state: "awake", label: "reconectado" },
            }),
          );
        }
        return;
      }

      const authTimer = setTimeout(() => {
        if (!ws.authenticated) ws.close();
      }, AUTH_TIMEOUT_MS);

      ws.on("message", (raw) => {
        try {
          const frame = JSON.parse(String(raw));
          if (frame.t === "auth" && validateStreamSessionToken(frame.token)) {
            ws.authenticated = true;
            clearTimeout(authTimer);
            clients.add(ws);
            ws.send(JSON.stringify({ t: "auth_ok" }));
          }
        } catch {
          // ignore
        }
      });

      ws.on("close", () => {
        clearTimeout(authTimer);
        clients.delete(ws);
      });
    });
  });

  return wss;
}
