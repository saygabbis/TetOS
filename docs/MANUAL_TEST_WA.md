# Teste manual WhatsApp — Teto IA Viva

Rode com o bot ativo e `npm run mind:watch` em outro terminal.

## Preparação

```bash
npm run start:wa
npm run mind:watch
```

Confirme no `.env`:

- `REPLY_ENABLED=true`
- `LEARNING_MODE_ENABLED=true`
- `TETOS_ACTIVATION_REQUIRED=false` (modo aberto — qualquer um conversa)

## Checklist DM (5–10 mensagens)

1. Mande `oi` — ela responde com delay humano (typing).
2. Pergunte algo que você já disse antes — memória/contexto aparece na resposta.
3. Mande `[SEM_RESPOSTA]` mental: peça pra ela encerrar naturalmente — verifique `closeDecision` no log.
4. `/teto-desativar` → ela confirma (só bloqueia se `TETOS_ACTIVATION_REQUIRED=true`).
5. `/teto-ativar` → reativa.

## Checklist grupo

1. `/teto-grupo-ativar` no grupo.
2. Mensagem sem menção — **sem resposta**, mas entra em `groupMemory`.
3. Mensagem com `@Teto` ou reply — responde.
4. `/teto-grupo-desativar` — para de responder (com ativação obrigatória).

## O que observar no `mind:watch`

- `reasons[]` no timing (50+ checks agregados).
- `trustBond` subindo devagar após várias msgs.
- `worldContext` ocasional se viagem autônoma disparar (raro).

## Modo só ativação (depois)

```env
TETOS_ACTIVATION_REQUIRED=true
```

Reinicie o bot. Só quem mandou `/teto-ativar` (DM) ou `/teto-grupo-ativar` (grupo) recebe resposta.
