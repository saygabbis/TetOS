#!/usr/bin/env bash
# Deploy do runner WhatsApp (npm run start:wa) em produção via GNU screen.
# Executado no servidor após git pull/reset pelo GitHub Actions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCREEN_NAME="${TETOS_SCREEN_NAME:-TetOS}"
START_CMD="${TETOS_START_CMD:-npm run start:wa}"

if [ ! -f ".env" ]; then
  echo "[deploy-wa] ERRO: arquivo .env ausente em $ROOT" >&2
  echo "[deploy-wa] Crie o .env no servidor antes do primeiro deploy." >&2
  exit 1
fi

if ! command -v screen >/dev/null 2>&1; then
  echo "[deploy-wa] ERRO: GNU screen não encontrado. Instale com: sudo apt install screen" >&2
  exit 1
fi

screen_exists() {
  screen -ls | grep -q "[0-9]*\.${SCREEN_NAME}[[:space:]]"
}

echo "[deploy-wa] Instalando dependências de produção..."
npm ci --omit=dev

if screen_exists; then
  echo "[deploy-wa] Reiniciando processo na screen ${SCREEN_NAME}..."
  screen -S "$SCREEN_NAME" -X stuff $'\003'
  sleep 3
  screen -S "$SCREEN_NAME" -X stuff "cd \"$ROOT\" && ${START_CMD}\n"
else
  echo "[deploy-wa] Screen ${SCREEN_NAME} não encontrada — criando..."
  screen -dmS "$SCREEN_NAME" bash -lc "cd \"$ROOT\" && exec ${START_CMD}"
fi

sleep 2

if screen_exists; then
  echo "[deploy-wa] Deploy concluído. Screen ativa:"
  screen -ls | grep "${SCREEN_NAME}" || true
  echo "[deploy-wa] Para ver logs: screen -r ${SCREEN_NAME}"
else
  echo "[deploy-wa] ERRO: screen ${SCREEN_NAME} não está rodando após o deploy." >&2
  exit 1
fi
