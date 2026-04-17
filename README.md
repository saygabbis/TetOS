# TetOS

TetOS é um bot local com API HTTP, runtime modular e integração com WhatsApp. Nesta fase, a base foi consolidada com memória seletiva, memória multimodal com retrieval recente, reminders locais com scheduler e entrega real via WhatsApp, observabilidade persistida e fluxo sticker-only funcional.

## Estado atual

A base atual da TetOS já cobre:
- arquitetura modular por runtime
- pipeline central de mensagens
- memória short-term, long-term e selective
- memória multimodal com recuperação recente no prompt
- governança de canal e modos passivos
- quoted context e persistência de mídia
- busca web
- documentos locais e escrita assistida
- operações administrativas e confirmações seguras
- reminders locais com scheduler e entrega no WhatsApp
- logs estruturados e métricas persistidas
- endpoints de inspeção operacional
- sticker-only com fallback de assets
- execução por PM2

## Pré-requisitos

- Node.js 18+
- npm
- Ollama local ou Ollama Cloud
- WhatsApp opcional para a camada de automação real

## Instalação

```bash
cd "C:\Users\jonas\OneDrive\Documentos\GABBIS\BOTS\TetOS"
npm install
```

## Configuração principal

Copie `.env.example` para `.env` e ajuste o necessário.

### Ollama local
- `TETOS_OLLAMA_MODE=local`
- `TETOS_MODEL=llama3`
- `TETOS_OLLAMA_URL=http://localhost:11434`

### Ollama Cloud
- `TETOS_OLLAMA_MODE=cloud`
- `TETOS_OLLAMA_API_KEY=<sua chave>`
- `TETOS_MODEL=minimax-m2.7:cloud`
- opcional: `TETOS_OLLAMA_CLOUD_URL`

### WhatsApp
- `WHATSAPP_ENABLED=true`
- `WHATSAPP_AUTO_CONNECT=true`
- `WHATSAPP_SESSION_PATH=./data/session`

### Reminders e sticker-only
- `TETOS_REMINDER_SWEEP_MS=60000`
- `TETOS_REMINDER_MAX_DELIVERY_ATTEMPTS=5`
- `TETOS_REMINDER_DELIVERY_RETRY_MS=300000`
- `TETOS_STICKER_ONLY_CHANCE=0.35`
- `TETOS_STICKERS_PATH=./data/stickers`

## Como subir

### 1. API HTTP
```bash
npm start
```

Ou:
```bash
npm run start:api
```

### 2. Runner do WhatsApp
```bash
npm run start:wa
```

No primeiro start, autentique via QR.

### 3. PM2
```bash
npm run pm2:start
npm run pm2:restart
npm run pm2:stop
```

## Scripts úteis

```bash
npm test
npm run test:status
npm run test:chat
npm run test:memory:save
npm run test:memory:search
npm run test:memory:search:post
npm run test:memory:delete -- <id>
npm run test:session:clear
```

## Principais capacidades implementadas

### Pipeline e memória
- pipeline central de mensagens com política de canal
- recent history normalizado por sessão
- extração de facts e style
- memória seletiva com promoção
- multimodal memory persistida
- retrieval recente multimodal injetado no prompt via `[RECENT MULTIMODAL MEMORY]`

### Reminders
- criação, listagem e conclusão de reminders
- scheduler local com `due()`, `sweep()` e `lastSweepAt`
- fila de entrega pendente com `pendingDelivery()`
- entrega real de reminders vencidos via WhatsApp
- `deliveryAttempts`, `delivered`, `deliveredAt`, `deliveryError`
- retry/backoff com limite de tentativas
- proteção contra destinatário inválido

### Observabilidade
- logs estruturados persistidos
- métricas persistidas
- `memorySummary`
- `runtimeSummary`
- `reminderSummary`
- `logsSummary`
- status operacional mais rico em `/status`

### Sticker-only
- envio de sticker no fluxo passivo
- assets locais em `data/stickers`
- fallback automático para `ack`, `ok`, `thumbs_up`, `heart`
- métricas e logs para sticker enviado, erro e asset ausente

## Assets de sticker atuais

A pasta `data/stickers` já foi preparada com:
- `ack.webp`
- `ok.webp`
- `heart.webp`
- `thumbs_up.webp`

Eles funcionam como placeholders operacionais e podem ser trocados depois por assets finais.

## Endpoints principais

### Chat e memória
- `POST /chat`
- `POST /memory/save`
- `POST /memory/delete`
- `GET /memory`
- `GET /memory/search`
- `POST /memory/search`
- `GET /memory/multimodal`
- `POST /session/clear`

### Operação e inspeção
- `GET /status`
- `GET /runtime/summary`
- `GET /logs`
- `GET /metrics`
- `GET /channels`
- `GET /channels/:channelId`
- `POST /channels/admin`
- `POST /operations`

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

## O que observar no /status

`GET /status` agora retorna, entre outros:
- `memorySummary`
- `runtimeSummary`
- `reminderSummary`
- `logsSummary`
- `metrics`
- limites ativos

## Fluxo recomendado de teste

### Teste da API
1. subir a API
2. chamar `GET /status`
3. chamar `GET /reminders`
4. executar `npm run test:status`
5. executar `npm run test:chat`

### Teste de reminders no WhatsApp
1. subir API e runner
2. criar reminder com `dueAt` próximo
3. aguardar o sweep
4. conferir entrega no WhatsApp
5. validar `GET /reminders?filter=pending`
6. validar `GET /reminders?filter=delivered`
7. validar `GET /status`

### Teste de sticker-only
1. manter assets na pasta `data/stickers`
2. provocar cenário passivo com `react_only`
3. conferir se foi enviado sticker
4. validar fallback para `ack` se a chave pedida não existir

## Problemas comuns

- `fetch failed`: Ollama local não está rodando ou modelo ausente
- `401` no modo cloud: chave inválida ou ausente
- sem resposta no WhatsApp: `WHATSAPP_ENABLED=true` não configurado ou sessão não autenticada
- reminder não entregue: verificar `deliveryError`, `deliveryAttempts`, `retryBlocked` e logs
- sticker não apareceu: verificar `data/stickers` e eventos `whatsapp.sticker_missing_asset`

## Estrutura operacional relevante

- `src/core/pipeline/messagePipeline.js`
- `src/core/memory/multimodalRetrieval.js`
- `src/modules/reminders/reminderStore.js`
- `src/modules/reminders/reminderScheduler.js`
- `src/modules/reminders/reminderSummary.js`
- `src/app/createRuntime.js`
- `src/integrations/whatsapp/runner.js`
- `src/integrations/whatsapp/messageHandler.js`
- `src/integrations/whatsapp/stickerAssets.js`
- `src/infra/api/server.js`
- `src/infra/config/defaults.js`

## Próximos passos opcionais

A fase atual está fechada. Se houver uma nova fase no futuro, os melhores próximos passos seriam:
- trocar stickers placeholder por assets finais
- adicionar testes E2E automatizados para reminders e WhatsApp
- melhorar workflows de calendário
- aprofundar automações contextuais seguras
- refinar UX das mensagens de lembrete e operação
