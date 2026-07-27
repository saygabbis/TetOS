# Deploy do WhatsApp Runner (`npm run start:wa`)

Este guia descreve como configurar **CI** (testes automáticos) e **CD** (deploy automático do runner WhatsApp) com GitHub Actions.

## Visão geral

| Etapa | Workflow | Quando roda | O que faz |
|-------|----------|-------------|-----------|
| **CI** | `.github/workflows/ci.yml` (job `test`) | Push e PR na `main` | `npm ci` + `npm run test:ci` |
| **CD** | `.github/workflows/ci.yml` (job `deploy`) | Push na `main` (após testes) ou manual | SSH no servidor → `git pull` → `scripts/deploy-wa.sh` → PM2 `tetos-wa` |

Fluxo após merge na `main`:

```mermaid
flowchart LR
  A[Push na main] --> B[CI — testes]
  B -->|sucesso| C[CD — SSH no servidor]
  C --> D[npm ci --omit=dev]
  D --> E[pm2 restart tetos-wa]
```

O runner em produção equivale a:

```bash
npm run start:wa
# node src/integrations/whatsapp/runner.js
```

Gerenciado pelo PM2 como processo `tetos-wa` (ver `scripts/pm2.config.cjs`).

---

## 1. Preparar o servidor (VPS)

Requisitos:

- **Ubuntu/Debian** (ou Linux compatível)
- **Node.js 20+** (mesma versão do `.nvmrc`)
- **PM2** global
- **Git** com acesso ao repositório
- Porta SSH aberta para o GitHub Actions

### 1.1 Instalar Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # deve ser v20.x
```

### 1.2 Instalar PM2

```bash
sudo npm install -g pm2
pm2 startup    # siga as instruções para iniciar PM2 no boot
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

> **Sessão WhatsApp:** `data/session/` não vai para o Git. No primeiro start, escaneie o QR Code no terminal do servidor (`pm2 logs tetos-wa`).

### 1.5 Primeiro start manual

```bash
cd /opt/tetos
npm ci
pm2 start scripts/pm2.config.cjs --only tetos-wa
pm2 save
pm2 logs tetos-wa
```

Confirme que o bot conectou antes de ativar o CD automático.

---

## 2. Configurar GitHub Secrets

No repositório: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Obrigatório | Exemplo | Descrição |
|--------|-------------|---------|-----------|
| `SSH_HOST` | Sim | `203.0.113.10` | IP ou hostname da VPS |
| `SSH_USER` | Sim | `deploy` | Usuário SSH |
| `SSH_PRIVATE_KEY` | Sim | conteúdo da chave privada | Chave **sem senha** para o Actions |
| `DEPLOY_PATH` | Sim | `/opt/tetos` | Caminho do clone no servidor |
| `SSH_PORT` | Não | `22` | Porta SSH (padrão: 22) |

### 2.1 Gerar chave SSH para deploy

No seu computador local:

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
- Executar `git`, `npm`, `pm2`
- Ler o `.env` (não versionado)

Exemplo de `authorized_keys` com restrições opcionais:

```
command="cd /opt/tetos && $SSH_ORIGINAL_COMMAND" ssh-ed25519 AAAA... github-actions-tetos-wa
```

---

## 3. Workflow unificado

Arquivo: `.github/workflows/ci.yml` (nome **CI/CD** no GitHub Actions).

### Job `test` — CI

Roda em todo **push** e **pull request** na branch `main`:

1. Checkout do código
2. Node.js 20 (`.nvmrc`)
3. `npm ci`
4. `npm run test:ci`

Para validar localmente antes de abrir PR:

```bash
npm ci
$env:CI='true'; npm run test:ci   # PowerShell
# CI=true npm run test:ci         # Linux/macOS
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
- Reinicia `tetos-wa` no PM2 (ou inicia se for a primeira vez)
- Executa `pm2 save`

---

## 4. Deploy manual

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

## 5. Operação e monitoramento

```bash
# Status
pm2 status tetos-wa

# Logs em tempo real
pm2 logs tetos-wa

# Reinício manual
pm2 restart tetos-wa --update-env

# Parar
pm2 stop tetos-wa
```

Após deploy, valide:

- `pm2 status` mostra `tetos-wa` como `online`
- Logs sem erros de conexão WhatsApp
- Bot responde a uma mensagem de teste

---

## 6. Troubleshooting

| Problema | Causa provável | Solução |
|----------|----------------|---------|
| CD não dispara | CI falhou ou push não foi na `main` | Corrija o CI; confira branch |
| `Permission denied (publickey)` | Chave SSH incorreta | Revise `SSH_PRIVATE_KEY` e `authorized_keys` |
| `DEPLOY_PATH: No such file` | Caminho errado no secret | Ajuste `DEPLOY_PATH` |
| `.env ausente` | Primeiro deploy sem config | Crie `.env` no servidor |
| Bot pede QR de novo | Sessão apagada ou `data/session` limpo | `pm2 logs tetos-wa`, escaneie QR; não apague `data/session` |
| `npm ci` falha | Node desatualizado no servidor | Instale Node 20+ |
| PM2 não encontrado | PM2 não instalado globalmente | `sudo npm i -g pm2` |

---

## 7. Segurança

- **Nunca** commite `.env` ou `data/session/`.
- Use um usuário Linux dedicado ao deploy (não `root`).
- Restrinja a chave SSH só ao host e comandos necessários.
- Rotacione chaves periodicamente.
- O CD só roda após CI verde na `main`.

---

## 8. Expandir no futuro

Esta base separa CI e CD e pode evoluir para:

- Deploy da API (`tetos-api`) com workflow `cd-api.yml`
- Ambientes `staging` / `production` com secrets por environment
- Notificação no Discord/Telegram após deploy
- Health check HTTP pós-deploy (`GET /status` se a API estiver na mesma VPS)

Arquivos relacionados:

- `scripts/pm2.config.cjs` — definição dos processos PM2
- `scripts/deploy-wa.sh` — script de deploy no servidor
- `.github/workflows/ci.yml` — pipeline CI/CD (testes + deploy)
