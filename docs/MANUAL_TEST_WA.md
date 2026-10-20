# Teste Manual WhatsApp - Teto IA Viva

Rode com o bot ativo e, se quiser observar a mente/logs em tempo real, use `npm run mind:watch` em outro terminal.

## Preparação

```bash
npm run start:wa
npm run mind:watch
```

Confirme no `.env`:

```env
WHATSAPP_ENABLED=true
REPLY_ENABLED=true
LEARNING_MODE_ENABLED=true
TETOS_ACTIVATION_REQUIRED=false
```

Com `TETOS_ACTIVATION_REQUIRED=false`, qualquer contato pode conversar. Com `true`, use os comandos de ativação antes dos testes.

## Checklist DM

1. Mande `oi` e confirme delay humano/typing.
2. Pergunte algo que você já disse antes e observe se memória/contexto aparece.
3. Peça para ela encerrar naturalmente e veja `closeDecision` no log.
4. Se ativação obrigatória estiver ligada, mande `/teto-desativar` e confirme que para de responder.
5. Mande `/teto-ativar` e confirme que reativa.

## Checklist Grupo

1. Mande `/teto-grupo-ativar` no grupo se `TETOS_ACTIVATION_REQUIRED=true`.
2. Envie mensagem sem menção e observe se entra em memória de grupo sem resposta indevida.
3. Mencione `@Teto`, chame pelo nome ou responda uma mensagem dela e confirme resposta.
4. Teste a janela de engajamento: depois de uma menção, mande outra mensagem sem `@` dentro de `TETOS_GROUP_ENGAGEMENT_MS`.
5. Mande `/teto-grupo-desativar` e confirme que para de responder quando ativação obrigatória estiver ligada.

## Checklist Comandos de Mídia

Use o prefixo configurado em `COMMAND_PREFIX` (padrão `.`).

1. Envie imagem/vídeo/GIF e mande `.sticker`.
2. Responda uma figurinha com `.toimg`.
3. Teste `.fsticker` para conter sem cortar.
4. Teste `.csticker` para crop central.
5. Em imagem ou figurinha estática, teste `.removebg`.
6. Mande `.help` e confira a lista atual.

## Checklist Repertório e Comandos do Agente

1. Peça para ativar o repertório (`modoRepertorio("on")`) e envie uma figurinha; confira entrada em `data/stickers/catalog.json`.
2. Peça para salvar uma figurinha específica com `salvarSticker("message_id")`.
3. Peça para enviar uma figurinha do catálogo e observe `sticker("chave")` no log/resposta.
4. Teste reação via conversa quando apropriado (`reagir("❤️")` na saída do agente).
5. Confira se figurinhas enviadas pelo agente usam chaves existentes em `data/stickers/`.

## Checklist Novidades (reforma de outubro/2026)

1. **Rajada**: mande 3 mensagens seguidas com pausas ("oi" / "tudo bem?" / "queria te contar uma coisa") → 1 resposta só.
2. **Digitando**: escreva "então tipo" e continue digitando → ela espera você terminar.
3. **Áudio**: mande uma mensagem de voz → ela responde ao que foi falado.
4. **Voz**: "manda um áudio me dando boa noite" → chega mensagem de voz.
5. **Link**: mande um link do YouTube/X sem pedir nada → ela comenta o conteúdo (não baixa). "baixa em mp3" → baixa.
6. **Clima**: "vai chover amanhã?" → previsão real.
7. **Vida**: "o que você tá fazendo?" → bate com `GET /life/now`; se estiver ocupada/dormindo, ela responde depois.
8. **Memória**: conte algo com data ("sexta tenho entrevista"); ~15 min depois a conversa esfria e entra no caderno
   (`GET /people/<id>`); depois do dia, ela pode perguntar "e aí, como foi?".
9. **Grupo/privacidade**: conte um segredo no PV; no grupo, outra pessoa pergunta → "sei de nada não kkk".
10. **Grupo/flood**: 3 pessoas chamando ao mesmo tempo → 1 resposta com até 2 bolhas, falando com cada um.

## O Que Observar no `mind:watch`

- `reasons[]` no timing.
- `trustBond` evoluindo gradualmente após várias mensagens.
- `groupMemory` sendo alimentada em grupo.
- `closeDecision` quando a conversa pede encerramento.
- logs `[iniciativa]`, `away_hold`/`sleep_hold` e `pegou o celular` (respostas adiadas).
- eventos `repertoire.vision` ao salvar figurinhas com visão.

## Modo Só Ativação

```env
TETOS_ACTIVATION_REQUIRED=true
```

Reinicie o bot. Só quem mandou `/teto-ativar` no DM ou `/teto-grupo-ativar` no grupo recebe resposta.
