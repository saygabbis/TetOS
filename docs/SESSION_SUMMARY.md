# TetOS - Session Summary (Etapa 1)

Este arquivo é um registro histórico da primeira etapa do projeto. Para instruções atuais de instalação, uso e endpoints, consulte `README.md` e `docs/RUNBOOK.md`.

## Estrutura Criada na Etapa

```text
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

## Núcleo Implementado

### Agent

Arquivo: `src/core/agent/agent.js`

Na etapa inicial, o agente fazia a orquestração base:

- memória
- prompt
- LLM
- atualização de memória

O prompt era dividido em blocos como `[SYSTEM]`, `[MEMORY]`, `[RECENT CONVERSATION]`, `[META]` e `[INPUT]`.

### Personality

Arquivos:

- `data/personality.json`
- `src/core/personality/index.js`

Base de personalidade da Kasane Teto, com traços, quirks, estilo e restrições.

### Memory

Arquivos iniciais:

- `src/core/memory/shortTerm.js`
- `src/core/memory/longTerm.js`
- `src/core/memory/contextBuilder.js`
- `src/core/memory/tagger.js`

A base atual evoluiu além disso e inclui memória seletiva, episódica, multimodal e de grupo.

### Brain

Arquivo inicial:

- `src/core/brain/ollamaClient.js`

O projeto hoje também possui `src/core/brain/minimaxClient.js` e seleção de provider por `TETOS_LLM_PROVIDER`.

## API Inicial

Arquivo: `src/infra/api/server.js`

Endpoints documentados na etapa:

- `POST /chat`
- `POST /memory/save`
- `POST /memory/delete`
- `GET /memory`
- `GET /memory/search`
- `POST /memory/search`
- `POST /session/clear`
- `GET /status`

Endpoints atuais adicionais estão no `README.md`.

## Scripts de Teste da Etapa

- `scripts/test-chat.js`
- `scripts/test-status.js`
- `scripts/test-session-clear.js`
- `scripts/test-memory-save.js`
- `scripts/test-memory-search.js`
- `scripts/test-memory-search-post.js`
- `scripts/test-memory-delete.js`

## Observação Atual

Este resumo não substitui a documentação operacional atual. Ele existe para preservar o contexto da primeira etapa.
