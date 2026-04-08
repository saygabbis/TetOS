# TetOS

## Como iniciar (rápido)
```bash
cd "C:\Users\jonas\OneDrive\Documentos\GABBIS\BOTS\TetOS"
npm install
```

## Pré-requisitos
- Node.js 18+
- Ollama instalado: [https://ollama.com/download](https://ollama.com/download)

## Configuração
1. Copie `.env.example` para `.env`.
2. Verifique os campos principais:
   - `TETOS_MODEL=llama3`
   - `TETOS_OLLAMA_URL=http://localhost:11434`
   - `WHATSAPP_ENABLED=true` (para testar no WhatsApp)

## Subir serviços
### 1) Inicie o Ollama e baixe o modelo
```bash
ollama serve
ollama pull llama3
```

### 2) Inicie a API (HTTP)
```bash
npm start
```

### 3) Inicie o bot do WhatsApp (em outro terminal)
```bash
npm run start:wa
```

No primeiro start do WhatsApp, escaneie o QR no terminal.

## Testes rápidos
Em outro terminal, com a API rodando:
```bash
node scripts/test-status.js
node scripts/test-chat.js
node scripts/test-session-clear.js
node scripts/test-memory-search.js
node scripts/test-memory-save.js
node scripts/test-memory-delete.js <id>
node scripts/test-memory-search-post.js
node scripts/chat-repl.js
```

## Problemas comuns
- `fetch failed` no `/chat`: Ollama não está rodando ou modelo ausente.
- Sem resposta no WhatsApp: confira `WHATSAPP_ENABLED=true` e se o QR foi autenticado.

## Config
Copy `.env.example` to `.env` and adjust if needed:
- `TETOS_MODEL`
- `TETOS_OLLAMA_URL`
- `TETOS_MEMORY_PATH`
- `TETOS_MAX_SHORT`
- `TETOS_PORT`
- `TETOS_PERSONALITY_PATH`
- `TETOS_MAX_HISTORY`
- `TETOS_MAX_CONTENT`
- `TETOS_MAX_ID`
- `TETOS_MAX_TAGS`
- `TETOS_RESPONSE_HISTORY`
- `TETOS_RESPONSE_SIMILARITY`
- `TETOS_RESPONSE_MAX_PARTS`

## API
- `POST /chat` (accepts `message` or `messages[]`, optional `userId`, `sessionId`; roles allowed: user/assistant/system; missing role defaults to user; last TETOS_MAX_HISTORY kept; short-term separated by sessionId; userId/sessionId max TETOS_MAX_ID chars; message content max TETOS_MAX_CONTENT chars; tone detection + response processing; returns `replies[]`)
- `POST /memory/save` (accepts `tag` or `tags[]`, capped by TETOS_MAX_TAGS)
- `POST /memory/delete`
- `GET /memory`
- `GET /memory/search` (tag accepts CSV: `tag=bread,teto`)
- `POST /memory/search` (body: `{ tag, q }`)
- `POST /session/clear`
- `GET /status` (optional `sessionId` query; returns active limits)

### /chat payload example
```json
{
  "messages": [
    {"role": "user", "content": "oi"},
    {"role": "assistant", "content": "e aí"},
    {"role": "user", "content": "fala da baguete"}
  ],
  "userId": "u1",
  "sessionId": "s1"
}
```
