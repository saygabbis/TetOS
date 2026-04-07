# TetOS — Session Summary (Etapa 1)

## Estrutura criada
```
TetOS/
  src/
    core/
      agent/
      brain/
      memory/
      personality/
    modules/
      chat/
      scheduler/
      tools/
    infra/
      api/
      config/
      utils/
  data/
  scripts/
```

## Núcleo implementado
- **Agent** (orquestração): `src/core/agent/agent.js`
  - Pipeline: memória → prompt → LLM → atualização de memória.
  - Prompt dividido em blocos `[SYSTEM]`, `[MEMORY]`, `[RECENT CONVERSATION]`, `[META]`, `[INPUT]`.
  - Short-term por `sessionId`.
  - Suporte a history via `messages[]`.

- **Personality**: `data/personality.json` + loader `src/core/personality/index.js`
  - Personalidade Kasane Teto com traços/quirks/estilo/restrições.

- **Memory**:
  - Short-term: `src/core/memory/shortTerm.js` (por sessão).
  - Long-term: `src/core/memory/longTerm.js` (JSON, search, delete).
  - Context builder: `src/core/memory/contextBuilder.js` (tags + recência).
  - Auto-tagging: `src/core/memory/tagger.js`.

- **Brain (LLM)**: `src/core/brain/ollamaClient.js`
  - Integração com Ollama `/api/generate`.

## API (Express)
Arquivo: `src/infra/api/server.js`
Endpoints:
- `POST /chat`
  - Aceita `message` ou `messages[]`
  - `messages[]` com roles `user|assistant|system` (role inválida → `user`)
  - Limites: `TETOS_MAX_HISTORY`, `TETOS_MAX_CONTENT`, `TETOS_MAX_ID`
  - `userId`/`sessionId` limitados
- `POST /memory/save` (aceita `tag` ou `tags[]` até `TETOS_MAX_TAGS`)
- `POST /memory/delete`
- `GET /memory`
- `GET /memory/search` (tag CSV)
- `POST /memory/search`
- `POST /session/clear`
- `GET /status` (inclui limites ativos)

## Config
- `.env.example` com:
  - `TETOS_MODEL`, `TETOS_OLLAMA_URL`, `TETOS_MEMORY_PATH`, `TETOS_MAX_SHORT`, `TETOS_PORT`
  - `TETOS_PERSONALITY_PATH`, `TETOS_MAX_HISTORY`, `TETOS_MAX_CONTENT`, `TETOS_MAX_ID`, `TETOS_MAX_TAGS`

## Scripts de teste
- `scripts/test-chat.js`
- `scripts/test-status.js`
- `scripts/test-session-clear.js`
- `scripts/test-memory-save.js`
- `scripts/test-memory-search.js`
- `scripts/test-memory-search-post.js`
- `scripts/test-memory-delete.js <id>`

## README
Atualizado com todos endpoints, envs e exemplos.
