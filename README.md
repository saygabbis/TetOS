# TetOS

## Como iniciar (rápido)
```bash
cd "C:\Users\jonas\OneDrive\Documentos\GABBIS\BOTS\TetOS"
npm install
```

## Pré-requisitos
- Node.js 18+
- **Ollama local** *ou* **Ollama Cloud** (conta em [ollama.com](https://ollama.com) e chave em [ollama.com/settings/keys](https://ollama.com/settings/keys))

## Configuração
1. Copie `.env.example` para `.env`.
2. Escolha **local** ou **cloud** (veja abaixo) e ajuste os campos principais.
3. Para WhatsApp: `WHATSAPP_ENABLED=true`.

### Opção A — Ollama local (padrão)
- `TETOS_OLLAMA_MODE=local` (ou omita; o padrão é local)
- `TETOS_MODEL=llama3` (ou outro modelo que você tiver puxado)
- `TETOS_OLLAMA_URL=http://localhost:11434`

### Opção B — Ollama Cloud
O TetOS usa o mesmo cliente HTTP (`/api/generate`); em cloud a API fica em `https://ollama.com` e exige autenticação por Bearer.

No `.env`:
- `TETOS_OLLAMA_MODE=cloud`
- `TETOS_OLLAMA_API_KEY=<sua chave>` (alternativa: `OLLAMA_API_KEY`, como na documentação da Ollama)
- Modelo padrão em cloud: **`minimax-m2.7:cloud`** (sobrescreva com `TETOS_MODEL` se quiser outro modelo cloud)
- Opcional: `TETOS_OLLAMA_CLOUD_URL` se precisar apontar para outro host (padrão `https://ollama.com`)

## Subir serviços
### 1) Ollama local: subir o daemon e o modelo
Ignore este passo se estiver só em **cloud**.

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

## Uso básico (chat REPL)
1. Suba a API com `npm start`.
2. Em outro terminal, rode:
```bash
node scripts/chat-repl.js
```
3. Converse normalmente. Use `/sair` para encerrar.

## Estabilização de conversa (pipeline)
- Separação rígida de input/output no REPL (evita mistura de stdout).
- Respostas multi-mensagem preservadas e com pacing entre partes.
- Split por sentença/linha com merge de fragmentos curtos (sem truncar conteúdo).
- Recência garantida nas últimas 3–5 mensagens do histórico.
- Logs de entrada, contexto usado, saída bruta e replies processadas.

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
- `fetch failed` no `/chat` (modo **local**): Ollama não está rodando ou modelo ausente.
- Erro 401 no `/chat` (modo **cloud**): `TETOS_OLLAMA_API_KEY` / `OLLAMA_API_KEY` ausente ou inválida.
- Sem resposta no WhatsApp: confira `WHATSAPP_ENABLED=true` e se o QR foi autenticado.

## Config
Copie `.env.example` para `.env` e ajuste:
- `TETOS_OLLAMA_MODE` (`local` | `cloud`)
- `TETOS_MODEL`
- `TETOS_OLLAMA_URL` (local)
- `TETOS_OLLAMA_API_KEY` ou `OLLAMA_API_KEY` (cloud)
- `TETOS_OLLAMA_CLOUD_URL` (cloud, opcional)
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
- `GET /status` (optional `sessionId` query; inclui `ollamaMode`, `ollamaBaseUrl`, `model`, limites ativos)

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
