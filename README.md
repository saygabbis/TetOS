# TetOS

## Quick start
```bash
cd "C:\Users\jonas\OneDrive\Documentos\GABBIS\BOTS\TetOS"
npm install
npm start
```

## Test
```bash
node scripts/test-chat.js
node scripts/test-status.js
node scripts/test-session-clear.js
node scripts/test-memory-search.js
node scripts/test-memory-save.js
node scripts/test-memory-delete.js <id>
node scripts/test-memory-search-post.js
```

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

## API
- `POST /chat` (accepts `message` or `messages[]`, optional `userId`, `sessionId`; roles allowed: user/assistant/system; missing role defaults to user; last TETOS_MAX_HISTORY kept; short-term separated by sessionId; userId/sessionId max TETOS_MAX_ID chars; message content max TETOS_MAX_CONTENT chars)
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
