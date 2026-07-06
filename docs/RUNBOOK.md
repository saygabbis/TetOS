# TetOS - Runbook

Este guia é o caminho curto para instalar, subir e validar o projeto no estado atual.

## 1. Instalar Dependências

Na raiz do projeto:

```bash
npm install
```

## 2. Configurar LLM

### Ollama local

Instale o Ollama em https://ollama.com/download, reabra o terminal e valide:

```bash
ollama --version
ollama serve
ollama pull llama3
```

No `.env`:

```env
TETOS_LLM_PROVIDER=ollama
TETOS_OLLAMA_MODE=local
TETOS_OLLAMA_URL=http://localhost:11434
TETOS_MODEL=llama3
```

### Ollama Cloud

```env
TETOS_LLM_PROVIDER=ollama
TETOS_OLLAMA_MODE=cloud
TETOS_OLLAMA_API_KEY=<sua chave>
TETOS_MODEL=minimax-m2.7:cloud
```

### MiniMax direto

```env
TETOS_LLM_PROVIDER=minimax
TETOS_MINIMAX_API_KEY=<sua chave>
TETOS_MINIMAX_MODEL=MiniMax-M2.7
```

## 3. Iniciar API

```bash
npm start
```

Valide em outro terminal:

```bash
npm run test:status
npm run test:chat
```

## 4. Rodar Testes Principais

```bash
npm test
npm run test:all
npm run test:brain:all
npm run test:architecture
```

Para fluxos específicos:

```bash
npm run test:memory:save
npm run test:memory:search
npm run test:memory:search:post
npm run test:session:clear
npm run test:timing
npm run test:trust
```

Para deletar memória por ID:

```bash
npm run test:memory:delete -- <id>
```

## 5. Iniciar WhatsApp

Confirme no `.env`:

```env
WHATSAPP_ENABLED=true
WHATSAPP_MODE=single
WHATSAPP_SESSION_PATH=./data/session
WHATSAPP_AUTO_CONNECT=true
REPLY_ENABLED=true
```

Suba:

```bash
npm run start:wa
```

No primeiro start, leia o QR Code.

## 6. PM2

```bash
npm run pm2:start
npm run pm2:restart
npm run pm2:stop
```

## 7. Ferramentas Operacionais

```bash
npm run mind:watch
npm run learn:focus
npm run life:distill
npm run data:sanitize
npm run wa:clear-sessions
```

## 8. Checklist Rápido

- `GET /status` responde.
- `POST /nudge` força iniciativa quando o runtime está ativo.
- `npm run test:chat` passa com o LLM configurado.
- `npm run test:architecture` passa para contratos de parser, modos e `decisionTrace`.
- `npm run test:brain:all` passa para a malha de comportamento.
- `npm run start:wa` conecta e recebe mensagens.
- `/teto-ativar` funciona no DM quando `TETOS_ACTIVATION_REQUIRED=true`.
- `.help` lista comandos de mídia no WhatsApp.

## Problemas Comuns

- `fetch failed`: Ollama local não está rodando, URL errada ou modelo ausente.
- `401`: chave cloud/API inválida ou ausente.
- API não sobe na porta esperada: confira `TETOS_PORT`.
- WhatsApp não responde: confira `WHATSAPP_ENABLED`, `REPLY_ENABLED`, sessão autenticada e ativação.
- Sticker-only passivo não sai: o planner usa a chave `ack` e `resolveStickerAsset()` procura `ack.webp`, depois `ok.webp`, `thumbs_up.webp` e `heart.webp` em `TETOS_STICKERS_PATH`. Adicione um desses arquivos ou ajuste o planner.
- Agente não envia figurinha: confira se a chave existe em `data/stickers/` ou em `data/stickers/catalog.json`; o agente usa `sticker("chave")` no repertório, não o fallback passivo.
- Repertório vazio: ative com `modoRepertorio("on")` ou salve figurinhas com `salvarSticker("message_id")`.
