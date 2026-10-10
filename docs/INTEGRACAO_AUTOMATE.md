# Integração AutoMate

A TetOS mantém o gateway `/device-link` e um cliente MCP perfil `delegate` (`automate_enqueue`, `automate_answer`, `automate_interrupt`).

## Tradução de eventos

| Notificação MCP | Evento UI |
|-----------------|-----------|
| `tool_call` | `plan.step` |
| `thinking` | `tool.log` |
| `clarification_needed` (pergunta) | `permission.request` |
| `clarification_needed` (ação manual) | `control.request` |
| `task_completed` | `run.status` completed |

Implementação: `src/integrations/automate/eventTranslator.js`.

## Auditoria

Chamadas enfileiradas em `data/automate-audit.ndjson`.

## Diagnóstico

Device offline: verifique `automate link` na máquina e token emitido via UI (não fica no log do servidor).

## Decisão da Teto (UI)

A rota `/ui/threads/:id/messages` usa o pipeline normal (`channelId: ui-desktop`). Para acionar o PC, a Teto emite `computador("intenção")` no protocolo de ações (`chatService.parseActionCommands`).

## MCP

O gateway usa `@modelcontextprotocol/sdk` (`Client` + `McpRelayTransport`) com `initialize` antes de `tools/call`.

## AutoMate Hub (cliente outbound)

Quando o frontend AutoMate usa o túnel do hub em vez de chamar o TetOS direto em `http://127.0.0.1:6453`, o **hub** encaminha RPC HTTP para a IA embutida via WebSocket `/agent-link`.

### Ativação

Defina no `.env`:

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `TETOS_HUB_AGENT_URL` | sim | Ex.: `wss://automate.esocrypta.com/agent-link` |
| `TETOS_HUB_AGENT_TOKEN` | sim | Segredo compartilhado com o hub (`agentId` fixo `tetos`) |
| `TETOS_HUB_AGENT_ID` | não | Padrão `tetos` |
| `TETOS_HUB_AGENT_CAPABILITIES` | não | Padrão `chat,rpc` |

Sem URL/token, o comportamento permanece o modo direto (REST `/ui/*` + `WS /stream`).

### Handshake e resiliência

1. TetOS abre WebSocket outbound e envia `hello` com `protocol: 1`, `agentId`, `token`, `capabilities` e `context: { methods: ["notifications/automate/"] }` (prefixos de notificação do AutoMate).
2. O hub responde `{ t: "ready", agent, devices }` ou `{ t: "denied", reason }`.
3. Responde `{ t: "ping" }` com `{ t: "pong" }` e envia `ping` JSON periódico (`TETOS_HUB_AGENT_HEARTBEAT_MS`, padrão 25s). O hub também usa `ws.ping()` nativo (30s).
4. Reconexão com backoff exponencial entre `TETOS_HUB_AGENT_RECONNECT_MIN_MS` e `TETOS_HUB_AGENT_RECONNECT_MAX_MS`.

### RPC (hub → IA)

- Hub → TetOS: `{ t: "rpc", rpcId, method, path, headers?, body?, bodyEncoding?, user }`
- TetOS → hub: `{ t: "rpc_result", rpcId, status, headers, body, bodyEncoding }` (`utf8` ou `base64`)

O TetOS reexecuta a chamada na API local (`127.0.0.1:TETOS_PORT`) com `TETOS_UI_SESSION_TOKEN`, só em `/ui/*` (nunca `/ui/devices*`).

### Chat / turnos (hub → IA)

- Hub → TetOS: `{ t: "message", agentId, threadId, message, history, user }` → dispara `POST /ui/threads/:id/messages`.
- Hub → TetOS: `{ t: "cancel", agentId, threadId }` → cancela o turno na UI.
- TetOS → hub: `{ t: "message", threadId?, message: { role, text, meta?, final? } }` quando a assistente finaliza (`message.final` no `UiEventBus`).
- TetOS → hub: `{ t: "event", threadId?, event, durable? }` para digitando, deltas e passos (`durable: true` em aprovações e fim de execução).

### Contexto AutoMate

Frames `{ t: "ctx", deviceId, method, params, ... }` são traduzidos com `eventTranslator` e republicados no `UiEventBus`.

Implementação: `src/integrations/automate-hub/`.
