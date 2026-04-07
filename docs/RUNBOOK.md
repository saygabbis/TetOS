# TetOS — Runbook (Testar agora)

## 1) Instalar dependências
```bash
cd "C:\Users\jonas\OneDrive\Documentos\GABBIS\BOTS\TetOS"
npm install
```

## 2) Instalar Ollama (Windows)
Baixe e instale: https://ollama.com/download

Depois reabra o terminal e rode:
```bash
ollama --version
```

## 3) Iniciar Ollama + baixar modelo
```bash
ollama serve
ollama pull llama3
```

## 4) (Opcional) Configurar .env
Copie `.env.example` para `.env` e ajuste:
- `TETOS_MODEL=llama3`
- `TETOS_OLLAMA_URL=http://localhost:11434`

## 5) Iniciar API
```bash
npm start
```

## 6) Testes
Em outro terminal:
```bash
node scripts/test-status.js
node scripts/test-chat.js
node scripts/test-memory-save.js
node scripts/test-memory-search.js
node scripts/test-memory-search-post.js
node scripts/test-session-clear.js
```

## 7) (Opcional) Deletar memória por ID
```bash
node scripts/test-memory-delete.js <id>
```

## Observação
Se o /chat retornar erro 500 “fetch failed”, o Ollama não está rodando ou o modelo não está disponível.
