# Runbook — API UI + AutoMate

## Local

1. **Configuração automática (recomendado):** na pasta `TetOS`, rode  
   `powershell -ExecutionPolicy Bypass -File scripts/setup-desktop-local.ps1`  
   Isso preenche `.env` da TetOS, do AutoMate e do app desktop com o token de `data/deviceTokens.json`.
2. `npm run start:api` — HTTP + `/stream` + `/device-link` (porta `TETOS_PORT` ou 6453).
3. Na máquina: `automate link` (usa `AUTOMATE_RELAY_*` do `.env`) ou link manual com token emitido em Ajustes.
4. Desktop: `pnpm --filter @tetos/desktop dev` (ou `tetos-desktop/scripts/dev-stack.ps1` para abrir os três processos).

## Produção (VPS)

- `TETOS_UI_SESSION_TOKEN` obrigatório (`NODE_ENV=production`).
- API e WhatsApp: `npm run pm2:start` (processos `tetos-api` e `tetos-wa`).
- Coloque TLS no proxy reverso (`wss://` para `/stream` e `/device-link`).
- Threads da UI: `data/uiThreads.json`.

## Falhas comuns

| Sintoma | Ação |
|---------|------|
| Device offline | Relay não conectado ou token revogado |
| Enqueue `text_required` | Cliente MCP deve enviar `{ text }` em `automate_enqueue` |
| Eventos sem runId | Registrar `instructionId` após enqueue (`automateRunContext`) |
