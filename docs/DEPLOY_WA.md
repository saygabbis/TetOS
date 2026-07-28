# Deploy do WhatsApp Runner (`npm run start:wa`)

Este guia descreve como configurar **CI** (testes automáticos) e **CD** (deploy automático do runner WhatsApp) com GitHub Actions.

Em produção, o projeto roda dentro de uma **GNU screen** chamada **`TetOS`** — não via PM2.

## Visão geral

| Etapa | Workflow | Quando roda | O que faz |
|-------|----------|-------------|-----------|
| **CI** | `.github/workflows/cicd.yml` (job `test`) | Push/PR na `main` que alterem código | `npm ci` + `npm run test:ci` |
| **CD** | `.github/workflows/cicd.yml` (job `deploy`) | Push na `main` com mudança de código (após testes) ou manual | SSH no servidor → `git pull` → `scripts/deploy-wa.sh` → reinicia na screen `TetOS` |
| **Backup** | `.github/workflows/backup-vps.yml` | Manual (Actions) | **Para a TetOS** → SSH na VPS → commit de `data/` → push na `main` → **permanece parada** |

> **Backup da VPS:** commits na `main` que alterem **apenas** `data/`, `docs/`, etc. **não disparam** CI/CD. Só mudanças em `src/`, `scripts/`, `tests/`, `package.json`, `.github/` ou `.nvmrc` acionam o pipeline. Deploy manual continua disponível em **Actions → CI/CD → Run workflow**.

Fluxo após merge na `main`:

```mermaid
flowchart LR
  A[Push na main] --> B[CI — testes]
  B -->|sucesso| C[CD — SSH no servidor]
  C --> D[npm ci --omit=dev]
  D --> E[reinicia npm run start:wa na screen TetOS]
```

O runner em produção equivale a:

```bash
screen -r TetOS
# dentro da screen:
npm run start:wa
# node src/integrations/whatsapp/runner.js
```

---

## 1. Preparar o servidor (VPS)

Requisitos:

- **Ubuntu/Debian** (ou Linux compatível)
- **Node.js 20+** (mesma versão do `.nvmrc`)
- **GNU screen**
- **Git** com acesso ao repositório
- Porta SSH aberta para o GitHub Actions

### 1.1 Instalar Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # deve ser v20.x
```

### 1.2 Instalar GNU screen

```bash
sudo apt-get install -y screen
screen -v
```

### 1.3 Clonar o repositório

```bash
sudo mkdir -p /opt/tetos
sudo chown "$USER":"$USER" /opt/tetos
git clone https://github.com/SEU_USUARIO/SEU_REPO.git /opt/tetos
cd /opt/tetos
```

### 1.4 Configurar ambiente

```bash
cp .env.example .env
nano .env
```

Variáveis mínimas para o WhatsApp:

```env
WHATSAPP_ENABLED=true
WHATSAPP_MODE=single
WHATSAPP_SESSION_PATH=./data/session
WHATSAPP_AUTO_CONNECT=true
REPLY_ENABLED=true
```

Configure também o LLM (`TETOS_LLM_PROVIDER`, chaves de API, etc.) conforme o [RUNBOOK](./RUNBOOK.md).

> **Sessão WhatsApp:** `data/session/` não vai para o Git. No primeiro start, escaneie o QR Code dentro da screen (`screen -r TetOS`).

### 1.5 Primeiro start manual (screen TetOS)

```bash
cd /opt/tetos
npm ci
screen -S TetOS
npm run start:wa
```

Escaneie o QR Code se necessário. Para sair **sem parar** o processo:

```
Ctrl+A, depois D
```

Confirme que o bot conectou antes de ativar o CD automático:

```bash
screen -ls    # deve listar algo como 12345.TetOS (Detached)
```

---

## 2. Configurar GitHub Secrets

No repositório: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Obrigatório | Exemplo | Descrição |
|--------|-------------|---------|-----------|
| `SSH_HOST` | Sim | `203.0.113.10` | IP ou hostname da VPS |
| `SSH_USER` | Sim | `deploy` | Usuário SSH |
| `SSH_PRIVATE_KEY` | Sim | conteúdo da chave privada | Chave **sem senha** para o Actions |
| `DEPLOY_PATH` | Sim | `/opt/tetos` | Caminho do clone no servidor |

### 2.1 Gerar chave SSH para deploy

No seu computador Linux:

```bash
ssh-keygen -t ed25519 -C "github-actions-tetos-wa" -f ~/.ssh/tetos_wa_deploy -N ""
```

- **Chave pública** → adicione em `~/.ssh/authorized_keys` do usuário de deploy no servidor.
- **Chave privada** (`tetos_wa_deploy`) → cole inteira no secret `SSH_PRIVATE_KEY`.

Teste antes de configurar o Actions:

```bash
ssh -i ~/.ssh/tetos_wa_deploy deploy@SEU_SERVIDOR "cd /opt/tetos && git status"
```

### 2.2 Permissões do usuário de deploy

O usuário SSH precisa de:

- Leitura/escrita em `DEPLOY_PATH`
- Executar `git`, `npm`, `screen`
- Ler o `.env` (não versionado)
- Acessar a screen `TetOS` (mesmo usuário que criou a sessão)
- Fazer `git push` via SSH no GitHub (para o workflow de backup)

### 2.3 Git SSH na VPS (para backup)

O backup usa o `git push` do próprio usuário da VPS — **sem token**.

No servidor, o clone deve usar remote SSH:

```bash
cd /opt/tetos
git remote -v
# origin  git@github.com:SEU_USUARIO/TetOS.git (fetch)
# origin  git@github.com:SEU_USUARIO/TetOS.git (push)
```

Se estiver em HTTPS, troque:

```bash
git remote set-url origin git@github.com:SEU_USUARIO/TetOS.git
```

Gere uma chave SSH **no servidor** (se ainda não tiver) e adicione em GitHub → **Settings → SSH keys**:

```bash
ssh-keygen -t ed25519 -C "tetos-vps-backup" -f ~/.ssh/id_ed25519_github -N ""
cat ~/.ssh/id_ed25519_github.pub
```

Teste:

```bash
ssh -T git@github.com
git push origin main --dry-run
```

---

## 3. Workflow unificado

Arquivo: `.github/workflows/cicd.yml` (nome **CI/CD** no GitHub Actions).

### Job `test` — CI

Roda em todo **push** e **pull request** na branch `main`:

1. Checkout do código
2. Node.js 20 (`.nvmrc`)
3. `npm ci`
4. `npm run test:ci`

Para validar localmente antes de abrir PR:

```bash
npm ci
CI=true npm run test:ci
```

### Job `deploy` — CD

Roda automaticamente após o job `test` passar, somente em:

- **Push na `main`**
- **Execução manual** em **Actions → CI/CD → Run workflow**

Em **pull requests**, só o job `test` roda (sem deploy).

Passos no servidor:

1. `git fetch` + `git reset --hard` no commit do push
2. `bash scripts/deploy-wa.sh`

O script `scripts/deploy-wa.sh`:

- Verifica se `.env` existe
- Roda `npm ci --omit=dev`
- Se a screen **`TetOS`** já existe: envia `Ctrl+C` e relança `npm run start:wa`
- Se não existe: cria `screen -dmS TetOS` com o comando de start

Variáveis opcionais no servidor:

```bash
export TETOS_SCREEN_NAME=TetOS      # padrão
export TETOS_START_CMD="npm run start:wa"  # padrão
```

---

## 4. Backup da VPS (GitHub Actions)

Arquivo: `.github/workflows/backup-vps.yml` (nome **Backup VPS (para a TetOS)** no GitHub Actions).

> **⚠️ AVISO:** Este workflow **para** o runner WhatsApp na screen `TetOS`, faz o backup e **deixa a aplicação parada**. Não há restart automático. Para subir de novo: `screen -r TetOS` + `npm run start:wa`, ou rode o workflow **CI/CD**.

### Como usar

1. Vá em **Actions** → **Backup VPS (para a TetOS)** → **Run workflow**
2. Leia o aviso exibido antes de confirmar
3. Opcional: preencha uma mensagem para o commit
4. O workflow conecta na VPS via SSH e executa `scripts/backup-vps.sh`

### Fluxo do backup

1. **Para** o runner (`Ctrl+C` na screen `TetOS`, ou `pkill` se necessário)
2. Sincroniza com `origin/main` (stash temporário das alterações locais)
3. Commita apenas `data/` (respeitando `.gitignore`)
4. Push na `main`
5. **Não reinicia** a TetOS

### O que é commitado

Por padrão, apenas alterações em `data/` que **não** estão no `.gitignore`:

- ✅ `data/memory.json`, `data/personality.json`, relatórios, etc.
- ❌ `data/session/` (sessão WhatsApp)
- ❌ `data/mind-log/`, `data/short-term/`
- ❌ `.env`

Se não houver mudanças versionáveis, o workflow termina sem criar commit.

### Por que não dispara deploy

O workflow **CI/CD** só reage a mudanças em `src/`, `scripts/`, `tests/`, etc. Commits de backup (só `data/`) **não reiniciam** a aplicação.

### Mensagem do commit

Formato automático:

```
backup(vps): 2026-07-28T18:30:00Z
```

Com mensagem customizada no workflow:

```
backup(vps): snapshot antes de migração
```

### Subir a TetOS de novo após backup

```bash
screen -r TetOS
npm run start:wa
# Ctrl+A, depois D
```

Ou rode o workflow **CI/CD** (deploy), que reinicia automaticamente.

### Backup manual no servidor

```bash
cd /opt/tetos
bash scripts/backup-vps.sh "minha mensagem"
```

---

## 5. Deploy manual

### Pelo GitHub Actions

1. Vá em **Actions**
2. Selecione **CI/CD**
3. **Run workflow** → escolha branch/ref (padrão: `main`)

### Direto no servidor

```bash
cd /opt/tetos
git pull origin main
bash scripts/deploy-wa.sh
```

---

## 6. Operação e monitoramento (screen)

```bash
# Listar screens
screen -ls

# Entrar na screen e ver logs ao vivo
screen -r TetOS

# Sair sem parar o processo
# Ctrl+A, depois D

# Reinício manual dentro da screen
screen -r TetOS
# Ctrl+C para parar
npm run start:wa
# Ctrl+A, D para detach

# Ou use o script de deploy
bash scripts/deploy-wa.sh
```

Após deploy, valide:

- `screen -ls` mostra `TetOS` como `(Detached)`
- Logs sem erros de conexão WhatsApp (`screen -r TetOS`)
- Bot responde a uma mensagem de teste

---

## 7. Troubleshooting

| Problema | Causa provável | Solução |
|----------|----------------|---------|
| CD não dispara | CI falhou ou push não foi na `main` | Corrija o CI; confira branch |
| `Permission denied (publickey)` | Chave SSH incorreta | Revise `SSH_PRIVATE_KEY` e `authorized_keys` |
| `DEPLOY_PATH: No such file` | Caminho errado no secret | Ajuste `DEPLOY_PATH` |
| `.env ausente` | Primeiro deploy sem config | Crie `.env` no servidor |
| Bot pede QR de novo | Sessão apagada ou `data/session` limpo | `screen -r TetOS`, escaneie QR; não apague `data/session` |
| `npm ci` falha | Node desatualizado no servidor | Instale Node 20+ |
| `screen: command not found` | GNU screen não instalado | `sudo apt install screen` |
| `Cannot open your terminal` | Deploy SSH sem TTY | Normal no Actions; o script usa `screen -X` (não precisa de TTY) |
| Screen existe mas processo não sobe | Node/npm fora do PATH no deploy | Use `bash -lc` ou ajuste `TETOS_START_CMD` com caminho completo do node |
| Backup: `cannot pull with rebase: unstaged changes` | VPS com arquivos modificados (normal em runtime) | Script atualizado faz stash antes do pull; atualize `scripts/backup-vps.sh` na VPS |
| Backup: `git push` falhou | Remote HTTPS ou chave SSH do usuário da VPS ausente | `git remote set-url origin git@github.com:USER/REPO.git` e teste `ssh -T git@github.com` |

---

## 8. Segurança

- **Nunca** commite `.env` ou `data/session/`.
- Use um usuário Linux dedicado ao deploy (não `root`).
- Restrinja a chave SSH só ao host e comandos necessários.
- Rotacione chaves periodicamente.
- O CD só roda após CI verde na `main`.

---

## 9. Expandir no futuro

Esta base pode evoluir para:

- Deploy da API (`start:api`) na mesma screen ou em outra
- Ambientes `staging` / `production` com secrets por environment
- Notificação no Discord/Telegram após deploy
- Health check HTTP pós-deploy (`GET /status` se a API estiver na mesma VPS)

Arquivos relacionados:

- `scripts/deploy-wa.sh` — script de deploy no servidor (screen `TetOS`)
- `scripts/backup-vps.sh` — script de backup (commit + push na `main`)
- `.github/workflows/cicd.yml` — pipeline CI/CD (testes + deploy)
- `.github/workflows/backup-vps.yml` — backup manual da VPS
