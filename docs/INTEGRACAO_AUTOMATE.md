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

1. TetOS abre WebSocket outbound e envia `hello` com `protocol: 1`, `agentId`, `token` e `capabilities`.
2. Após `hello_ok` / `welcome` / `ready`, encaminha eventos do `UiEventBus` como frames `{ t: "event", id, event }` (mesmo envelope de `/stream`).
3. Responde `ping` com `pong` e envia `ping` periódico (`TETOS_HUB_AGENT_HEARTBEAT_MS`, padrão 25s).
4. Reconexão com backoff exponencial entre `TETOS_HUB_AGENT_RECONNECT_MIN_MS` e `TETOS_HUB_AGENT_RECONNECT_MAX_MS`.

### RPC (`rpc` / `agent_rpc`)

O hub envia requisições HTTP contra as rotas `/ui/*`; o TetOS reexecuta essas chamadas na API local (`127.0.0.1:TETOS_PORT`), nos mesmos handlers Express, autorizado com `TETOS_UI_SESSION_TOKEN` (dono).

Formato aceito (campos equivalentes):

```json
{ "t": "rpc", "id": "1", "method": "GET", "path": "/ui/threads" }
```

ou `http` / `request` aninhado com `method`, `path`, `headers`, `body`.

### Chat

Frames `{ t: "chat", id, threadId?, text }` viram `POST /ui/threads/:id/messages`; a resposta da assistente continua chegando pelo stream (`event`).

Implementação: `src/integrations/automate-hub/`.
