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
