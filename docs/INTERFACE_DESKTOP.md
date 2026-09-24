# Interface desktop

## Autenticação

- Sessão UI: header `Authorization: Bearer <TETOS_UI_SESSION_TOKEN>` (padrão dev: `tetos-dev-session`).
- Device relay: token emitido em `data/deviceTokens.json` via `DeviceRegistry.issue`.

## REST

- `GET /ui/threads`
- `GET /ui/threads/:id`
- `POST /ui/threads/:id/messages`
- `POST /ui/runs/permission` — `{ requestId, answer: "confirm"|"deny" }`
- `POST /ui/runs/:runId/stop`
- `GET /ui/devices` / `POST /ui/devices/:id/revoke`

## WebSocket

- `WS /stream?token=<session>` — eventos do protocolo (`{ id, event }`).
- `WS /device-link` — relay MCP (handshake `hello` / `ready`).

Ver [INTEGRACAO_AUTOMATE.md](./INTEGRACAO_AUTOMATE.md).
