# TetOS

TetOS é um bot local com API HTTP, runtime modular e integração com WhatsApp. A base atual combina chat, memória, visão/mídia, documentos locais, reminders, observabilidade, automações de WhatsApp, comandos de figurinha e um runtime de "vida" da Teto.

## Estado Atual

A TetOS cobre hoje:
- API HTTP em Express.
- Pipeline central de mensagens.
- Memória short-term, long-term, seletiva, episódica, de grupo e multimodal.
- Retrieval multimodal recente injetado no prompt.
- Busca web e leitura via adapter.
- Documentos locais com leitura/escrita assistida.
- Operações administrativas com confirmações seguras.
- Reminders locais com scheduler e tentativa de entrega via WhatsApp.
- Logs estruturados, métricas persistidas e endpoints de inspeção.
- Integração WhatsApp via Baileys, com modo single ou dual.
- Comandos de mídia no WhatsApp: `.sticker`, `.fsticker`, `.csticker`, `.toimg`, `.removebg`, `.optimize` e `.help`.
- Repertório de figurinhas com catálogo (`data/stickers/catalog.json`), auto-save por visão e envio via `sticker("chave")` na resposta do agente.
- Ativação por DM/grupo com `/teto-ativar`, `/teto-desativar`, `/teto-grupo-ativar` e `/teto-grupo-desativar` (desativar persiste mesmo sem `TETOS_ACTIVATION_REQUIRED`).
- Comando de agente `calar()` — silencia o chat por ~1 min (ignora menção/reply); `/teto-desativar` e `/teto-grupo-desativar` desligam até reativar.
- Runtime de presença, timing, vida, emoção, aprendizado e relatórios diários.
- Execução por PM2.

## Pré-requisitos

- Node.js 18+.
- npm.
- Ollama local, Ollama Cloud ou MiniMax API direta.
- WhatsApp opcional para automação real.
- FFmpeg é usado em fluxos de mídia; o projeto inclui `@ffmpeg-installer/ffmpeg`.

## Instalação

Na raiz do projeto:

```bash
npm install
```

## Configuração

Copie `.env.example` para `.env` e ajuste o necessário.

### LLM

O provedor padrão é Ollama:

```env
TETOS_LLM_PROVIDER=ollama
TETOS_OLLAMA_MODE=local
TETOS_OLLAMA_URL=http://localhost:11434
TETOS_MODEL=llama3
```

Para Ollama Cloud:

```env
TETOS_OLLAMA_MODE=cloud
TETOS_OLLAMA_API_KEY=<sua chave>
TETOS_MODEL=minimax-m2.7:cloud
```

Para MiniMax direto:

```env
TETOS_LLM_PROVIDER=minimax
TETOS_MINIMAX_API_KEY=<sua chave>
TETOS_MINIMAX_MODEL=MiniMax-M2.7
```

### WhatsApp

Modo single, com um número para chat e comandos de mídia:

```env
WHATSAPP_ENABLED=true
WHATSAPP_MODE=single
WHATSAPP_SESSION_PATH=./data/session
WHATSAPP_AUTO_CONNECT=true
```

Modo dual, com uma sessão principal e outra para mídia:

```env
WHATSAPP_MODE=dual
WHATSAPP_MAIN_OBSERVE_ONLY=true
WHATSAPP_SESSION_PATH=./data/session
WHATSAPP_MEDIA_SESSION_PATH=./data/session-media
```

### Reminders e Stickers

```env
TETOS_REMINDER_SWEEP_MS=60000
TETOS_REMINDER_MAX_DELIVERY_ATTEMPTS=5
TETOS_REMINDER_DELIVERY_RETRY_MS=300000
TETOS_STICKER_ONLY_CHANCE=0.55
TETOS_STICKERS_PATH=./data/stickers
TETOS_STICKER_REPERTOIRE_MODE_PATH=./data/stickerRepertoireMode.json
```

Há dois fluxos de figurinha:

- **Passivo (`react_only`)**: o planner pede a chave `ack` e `resolveStickerAsset()` procura `ack.webp`, depois `ok.webp`, `thumbs_up.webp` e `heart.webp`. Adicione um desses em `data/stickers/` ou ajuste o planner.
- **Agente/repertório**: a Teto envia figurinhas do catálogo com `sticker("chave")` na resposta. Chaves vêm de `data/stickers/*.webp` e de `data/stickers/catalog.json` (salvas manualmente ou com `modoRepertorio("on")`).

## Como Subir

### API HTTP

```bash
npm start
```

ou:

```bash
npm run start:api
```

### Runner do WhatsApp

```bash
npm run start:wa
```

No primeiro start, autentique pelo QR Code.

### PM2

```bash
npm run pm2:start
npm run pm2:restart
npm run pm2:stop
```

## Scripts Úteis

```bash
npm test
npm run test:all
npm run test:architecture
npm run test:brain:all
npm run test:status
npm run test:chat
npm run test:memory:save
npm run test:memory:search
npm run test:memory:search:post
npm run test:memory:delete -- <id>
npm run test:session:clear
npm run test:minimax
npm run test:timing
npm run test:trust
npm run wa:clear-sessions
npm run mind:watch
npm run learn:focus
npm run life:distill
npm run data:sanitize
```

## Endpoints Principais

### Chat e Memória

- `POST /chat`
- `POST /nudge`
- `POST /memory/save`
- `POST /memory/delete`
- `GET /memory`
- `GET /memory/search`
- `POST /memory/search`
- `GET /memory/multimodal`
- `POST /session/clear`

### Operação e Inspeção

- `GET /status`
- `GET /runtime/summary`
- `GET /logs`
- `GET /metrics`
- `GET /channels`
- `GET /channels/:channelId`
- `POST /channels/admin`
- `POST /operations`
- `POST /search`

### Documentos

- `GET /documents`
- `GET /documents/:id`
- `POST /documents/:id`

### Reminders

- `GET /reminders`
- `GET /reminders?userId=<id>`
- `GET /reminders?filter=open`
- `GET /reminders?filter=pending`
- `GET /reminders?filter=delivered`
- `GET /reminders?filter=failed`

## O Que Observar em `/status`

`GET /status` retorna o estado operacional consolidado, incluindo:
- `memorySummary`
- `runtimeSummary`
- `reminderSummary`
- `logsSummary`
- `metrics`
- limites ativos

## Fluxo Recomendado de Teste

### API

1. Suba a API com `npm start`.
2. Chame `GET /status`.
3. Chame `GET /reminders`.
4. Execute `npm run test:status`.
5. Execute `npm run test:chat`.

### WhatsApp

1. Configure `.env`.
2. Suba `npm run start:wa`.
3. Leia o QR Code.
4. Teste `/teto-ativar` no DM.
5. Teste `.help` e um comando de figurinha com imagem ou sticker.

### Reminders

1. Suba API e runner do WhatsApp.
2. Crie um reminder com `dueAt` próximo.
3. Aguarde o sweep.
4. Confira entrega no WhatsApp.
5. Valide `GET /reminders?filter=pending`.
6. Valide `GET /reminders?filter=delivered`.
7. Valide `GET /status`.

## Problemas Comuns

- `fetch failed`: Ollama local não está rodando ou o modelo não está disponível.
- `401` no modo cloud/API: chave inválida ou ausente.
- Sem resposta no WhatsApp: verifique `WHATSAPP_ENABLED`, `REPLY_ENABLED`, sessão autenticada e `TETOS_ACTIVATION_REQUIRED`.
- Grupo sem resposta: use `/teto-grupo-ativar` quando a ativação estiver obrigatória, ou mencione/responda a Teto conforme a política do grupo.
- Reminder não entregue: verificar `deliveryError`, `deliveryAttempts`, `retryBlocked` e logs.
- Sticker-only passivo não apareceu: verifique `TETOS_STICKERS_PATH` e se existem `ack.webp`, `ok.webp`, `thumbs_up.webp` ou `heart.webp` (fluxo passivo, distinto do repertório do agente).
- Agente não mandou figurinha: confira se a chave existe no catálogo ou em `data/stickers/` e se o LLM emitiu `sticker("chave")` na resposta.
- Comando de mídia falhou: teste `.help`, confira se a mídia foi enviada como imagem/vídeo/sticker/documento aceito e veja logs em `data/logs/tetos.log`.

## Estrutura Relevante

- `src/app/createRuntime.js`
- `src/infra/api/server.js`
- `src/infra/config/defaults.js`
- `src/core/pipeline/messagePipeline.js`
- `src/core/agent/agent.js`
- `src/core/brain/ollamaClient.js`
- `src/core/brain/minimaxClient.js`
- `src/core/memory/`
- `src/core/channels/`
- `src/core/media/`
- `src/modules/chat/`
- `src/modules/reminders/`
- `src/modules/documents/`
- `src/modules/search/`
- `src/integrations/whatsapp/runner.js`
- `src/integrations/whatsapp/messageHandler.js`
- `src/integrations/whatsapp/stickerAssets.js`
- `src/integrations/whatsapp/stickerRepertoire.js`
- `src/integrations/whatsapp/agentMediaCommands.js`

## Documentação Técnica

- `docs/CAPACIDADES_TETO.md` - inventário prático de tudo que a Teto faz hoje.
- `docs/ARQUITETURA_E_FLUXOS.md` - mapa dos serviços em background, fluxos da API, WhatsApp, comandos, grupos, pipeline e decisões de resposta.
- `docs/RUNBOOK.md` - instalação, execução e validação rápida.
- `docs/MANUAL_TEST_WA.md` - roteiro manual para testar WhatsApp.
- `docs/HUMANIZATION_CHECKLIST.md` - checklist de humanização validado por testes.
- `docs/TETO_EXTENSIONS.md` - adapters e pontos de extensão.
- `docs/SESSION_SUMMARY.md` - registro histórico da etapa inicial.
- `docs/FASE_FINAL_RESUMO_COMPLETO.md` - registro histórico da fase de consolidação.

## Próximos Passos Opcionais

- Adicionar `ack.webp` (ou ajustar o planner passivo) para o sticker-only em modo `react_only`.
- Criar testes E2E para WhatsApp, reminders, repertório e comandos de mídia.
- Expandir exemplos de payload da API.
