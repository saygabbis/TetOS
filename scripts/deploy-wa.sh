#!/usr/bin/env bash
# Deploy do runner WhatsApp (npm run start:wa) em produção via PM2.
# Executado no servidor após git pull/reset pelo GitHub Actions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f ".env" ]; then
  echo "[deploy-wa] ERRO: arquivo .env ausente em $ROOT" >&2
  echo "[deploy-wa] Crie o .env no servidor antes do primeiro deploy." >&2
  exit 1
fi

echo "[deploy-wa] Instalando dependências de produção..."
npm ci --omit=dev

echo "[deploy-wa] Reiniciando tetos-wa (PM2)..."
if pm2 describe tetos-wa >/dev/null 2>&1; then
  pm2 restart tetos-wa --update-env
else
  pm2 start scripts/pm2.config.cjs --only tetos-wa
fi

pm2 save

echo "[deploy-wa] Deploy concluído."
pm2 status tetos-wa
