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

## AutoMate pelo WhatsApp (só a dona, no PV)

1. A dona pede no PV ("teto, abre o spotify no meu pc"). Se o PC está online, o prompt oferece `computador("…")`.
2. O runner do WhatsApp chama a API: `POST /automate/whatsapp/run {intent, jid}` (Bearer `TETOS_API_TOKEN` obrigatório).
   PC offline → 409 e ela avisa pra abrir o AutoMate.
3. A API enfileira no AutoMate (`automateClient.enqueue`, thread `wa:<jid>`).
4. Ao terminar, o resultado vai pra `data/whatsapp-outbox.json` (`kind: automate_outcome`); o runner explica no jeito dela.

Também: `GET /automate/status` (PC online?). Desligar: `TETOS_AUTOMATE_WHATSAPP=false`.

## MCP

- Para o PC: o gateway usa `@modelcontextprotocol/sdk` (`Client` + `McpRelayTransport`) com `initialize` antes de `tools/call`.
- Da Teto para outros apps: `npm run mcp` sobe `src/integrations/mcp/tetoMcpServer.js` (stdio). Ferramentas:
  `conversar_com_teto`, `o_que_a_teto_esta_fazendo`, `mandar_whatsapp`, `lembretes_da_teto`, `memoria_sobre_pessoa`.
  Config no cliente: `{"command":"node","args":["<repo>/src/integrations/mcp/tetoMcpServer.js"],"env":{"TETOS_API_URL":"http://127.0.0.1:3000","TETOS_API_TOKEN":"…"}}`.

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

### Acionar o PC pelo hub (`call`)

Com o hub ativo, o PC com AutoMate normalmente **não** conecta no `/device-link` da TetOS: ele conecta no hub. Então `automate_enqueue`, `automate_answer` e `automate_interrupt` saem da TetOS como frames `{ t: "call", id, deviceId, tool, args }` pelo `/agent-link`; o hub responde `{ t: "result", id, result }` ou `{ t: "error", id, code, message }` (`confirmation_denied`, `rate_limited`, `not_found`…).

- `HubDeviceGateway` (`src/integrations/automate-hub/hubDeviceGateway.js`) faz a chamada; o PC é escolhido entre os que o hub informa em `ready.devices` / `presence` (se o `deviceId` pedido, ex. `default-device`, não existir no hub, usa o único/primeiro PC online).
- `CompositeDeviceGateway` prefere o PC ligado direto ao `/device-link` local e cai para o hub quando não há.
- O perfil do relay do PC no hub precisa ser `delegate` ou `full` (as tools `automate_*` não existem em `direct`).
- Ações em `HUB_CONFIRM_TOOLS` pedem aprovação do usuário nos apps antes de rodar.
- Log de debug do gateway: só grava se `TETOS_DEBUG_LOG` apontar para um arquivo.

### Contexto AutoMate

Frames `{ t: "ctx", deviceId, method, params, ... }` são traduzidos com `eventTranslator` e republicados no `UiEventBus`.

Implementação: `src/integrations/automate-hub/`.
