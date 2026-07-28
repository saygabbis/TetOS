#!/usr/bin/env bash
# Backup do estado da VPS: commita arquivos versionáveis e envia para origin/main.
#
# AVISO: Este script PARA o runner WhatsApp (screen TetOS) antes do backup
# e deixa a aplicação PARADA ao final — não reinicia automaticamente.
#
# Usa o git/SSH já configurado no usuário da VPS (sem token).
# Respeita .gitignore (ex.: data/session/, .env não entram no commit).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_PATHS="${TETOS_BACKUP_PATHS:-data/}"
BRANCH="${TETOS_BACKUP_BRANCH:-main}"
REMOTE="${TETOS_BACKUP_REMOTE:-origin}"
SCREEN_NAME="${TETOS_SCREEN_NAME:-TetOS}"
RUNNER_MATCH="${TETOS_RUNNER_MATCH:-src/integrations/whatsapp/runner.js}"
STOP_WAIT_SECS="${TETOS_BACKUP_STOP_WAIT_SECS:-20}"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "[backup-vps] ERRO: remote '${REMOTE}' não configurado." >&2
  exit 1
fi

screen_exists() {
  screen -ls | grep -q "[0-9]*\.${SCREEN_NAME}[[:space:]]"
}

runner_running() {
  pgrep -f "$RUNNER_MATCH" >/dev/null 2>&1
}

stop_tetos_runner() {
  echo "[backup-vps] =============================================="
  echo "[backup-vps] AVISO: Parando TetOS para backup consistente..."
  echo "[backup-vps] =============================================="

  if ! command -v screen >/dev/null 2>&1; then
    echo "[backup-vps] AVISO: GNU screen não encontrado — tentando parar processo direto."
    if runner_running; then
      pkill -TERM -f "$RUNNER_MATCH" || true
      sleep 3
      if runner_running; then
        pkill -KILL -f "$RUNNER_MATCH" || true
      fi
    fi
    return
  fi

  if screen_exists; then
    if runner_running; then
      echo "[backup-vps] Enviando Ctrl+C na screen ${SCREEN_NAME}..."
      screen -S "$SCREEN_NAME" -X stuff $'\003'
    else
      echo "[backup-vps] Screen ${SCREEN_NAME} existe, mas runner não detectado."
    fi
  elif runner_running; then
    echo "[backup-vps] Runner ativo fora da screen — enviando SIGTERM..."
    pkill -TERM -f "$RUNNER_MATCH" || true
  else
    echo "[backup-vps] TetOS já parece estar parada."
    return
  fi

  for _ in $(seq 1 "$STOP_WAIT_SECS"); do
    if ! runner_running; then
      echo "[backup-vps] Runner parado."
      return
    fi
    sleep 1
  done

  if runner_running; then
    echo "[backup-vps] AVISO: Runner ainda ativo após ${STOP_WAIT_SECS}s — forçando parada..."
    pkill -KILL -f "$RUNNER_MATCH" || true
    sleep 2
  fi

  if runner_running; then
    echo "[backup-vps] ERRO: não foi possível parar o runner." >&2
    exit 1
  fi

  echo "[backup-vps] Runner parado com sucesso."
}

print_stopped_warning() {
  echo ""
  echo "[backup-vps] =============================================="
  echo "[backup-vps] AVISO: TetOS permanece PARADA após este backup."
  echo "[backup-vps] O bot NÃO foi reiniciado automaticamente."
  echo "[backup-vps]"
  echo "[backup-vps] Para subir de novo na VPS:"
  echo "[backup-vps]   screen -r ${SCREEN_NAME}"
  echo "[backup-vps]   npm run start:wa"
  echo "[backup-vps]"
  echo "[backup-vps] Ou rode o workflow CI/CD (deploy)."
  echo "[backup-vps] =============================================="
}

has_local_changes() {
  ! git diff --quiet || \
  ! git diff --cached --quiet || \
  [ -n "$(git ls-files --others --exclude-standard)" ]
}

CUSTOM_MSG="${1:-}"
if [ -n "$CUSTOM_MSG" ]; then
  COMMIT_MSG="backup(vps): ${CUSTOM_MSG}"
else
  COMMIT_MSG="backup(vps): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

stop_tetos_runner

REMOTE_URL="$(git remote get-url "$REMOTE")"
echo "[backup-vps] Remote ${REMOTE}: ${REMOTE_URL}"

STASHED=0
if has_local_changes; then
  echo "[backup-vps] Alterações locais detectadas — guardando em stash temporário..."
  git stash push -u -m "backup-vps-pre-sync-$$"
  STASHED=1
fi

echo "[backup-vps] Sincronizando com ${REMOTE}/${BRANCH}..."
git fetch "$REMOTE" "$BRANCH"
git pull --rebase "$REMOTE" "$BRANCH"

if [ "$STASHED" -eq 1 ]; then
  echo "[backup-vps] Restaurando alterações locais..."
  if ! git stash pop; then
    echo "[backup-vps] ERRO: conflito ao restaurar stash após o pull." >&2
    echo "[backup-vps] Resolva na VPS com: git stash list && git status" >&2
    print_stopped_warning
    exit 1
  fi
fi

echo "[backup-vps] Adicionando alterações em: ${BACKUP_PATHS}"
# shellcheck disable=SC2086
git add -- $BACKUP_PATHS

if git diff --staged --quiet; then
  echo "[backup-vps] Nada para commitar — VPS já está em sync com o que o Git rastreia."
  print_stopped_warning
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
  print_stopped_warning
  exit 1
fi

echo "[backup-vps] Backup concluído."
git log -1 --oneline
print_stopped_warning
