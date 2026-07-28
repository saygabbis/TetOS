#!/usr/bin/env bash
# Backup do estado da VPS: commita arquivos versionáveis e envia para origin/main.
# Usa o git/SSH já configurado no usuário da VPS (sem token).
# Respeita .gitignore (ex.: data/session/, .env não entram no commit).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_PATHS="${TETOS_BACKUP_PATHS:-data/}"
BRANCH="${TETOS_BACKUP_BRANCH:-main}"
REMOTE="${TETOS_BACKUP_REMOTE:-origin}"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "[backup-vps] ERRO: remote '${REMOTE}' não configurado." >&2
  exit 1
fi

CUSTOM_MSG="${1:-}"
if [ -n "$CUSTOM_MSG" ]; then
  COMMIT_MSG="backup(vps): ${CUSTOM_MSG}"
else
  COMMIT_MSG="backup(vps): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

REMOTE_URL="$(git remote get-url "$REMOTE")"
echo "[backup-vps] Remote ${REMOTE}: ${REMOTE_URL}"
echo "[backup-vps] Sincronizando com ${REMOTE}/${BRANCH}..."
git fetch "$REMOTE" "$BRANCH"
git pull --rebase "$REMOTE" "$BRANCH"

echo "[backup-vps] Adicionando alterações em: ${BACKUP_PATHS}"
# shellcheck disable=SC2086
git add -- $BACKUP_PATHS

if git diff --staged --quiet; then
  echo "[backup-vps] Nada para commitar — VPS já está em sync com o que o Git rastreia."
  exit 0
fi

echo "[backup-vps] Criando commit..."
git -c user.name="TetOS VPS Backup" \
    -c user.email="tetos-vps-backup@users.noreply.github.com" \
    commit -m "$COMMIT_MSG"

echo "[backup-vps] Enviando para ${REMOTE}/${BRANCH}..."
if ! git push "$REMOTE" "HEAD:${BRANCH}"; then
  echo "[backup-vps] ERRO: git push falhou." >&2
  echo "[backup-vps] Confira se o remote usa SSH (git@github.com:...) e se o usuário da VPS tem chave autorizada no GitHub." >&2
  exit 1
fi

echo "[backup-vps] Backup concluído."
git log -1 --oneline
