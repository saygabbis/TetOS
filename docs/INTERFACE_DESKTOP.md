# Interface desktop

## Autenticação

- Sessão UI: header `Authorization: Bearer <TETOS_UI_SESSION_TOKEN>` (padrão dev: `tetos-dev-session`).
- Device relay: token emitido em `data/deviceTokens.json` via `DeviceRegistry.issue`.

## REST

- `GET /ui/threads`
- `GET /ui/threads/:id`
- `POST /ui/threads/:id/messages`
- `POST /ui/runs/permission` — `{ requestId, answer: "confirm"|"deny" }`
- `POST /ui/runs/:runId/stop`
- `GET /ui/devices` / `POST /ui/devices/:id/revoke`

## WebSocket

- `WS /stream?token=<session>` — eventos do protocolo (`{ id, event }`).
- `WS /device-link` — relay MCP (handshake `hello` / `ready`).

Ver [INTEGRACAO_AUTOMATE.md](./INTEGRACAO_AUTOMATE.md).

## Mídia (paridade com o WhatsApp)

Tudo o que a Teto faz com mídia no WhatsApp também funciona na interface. As saídas chegam como
mensagens da Teto com `attachments` (`kind`: `image | video | audio | file | sticker`, `mediaId`, `animated`).

- `POST /ui/media` — upload binário (`Content-Type` = mime, `X-File-Name` = nome em `encodeURIComponent`). Devolve `{ media }`; envie `media` em `attachments` de `POST /ui/threads/:id/messages`. Limite: `TETOS_UI_UPLOAD_LIMIT_MB` (padrão 64).
- `GET /ui/media/:id` — baixa a mídia. Aceita `Authorization` **ou** `?token=<sessão>` (para `<img>`/`<video>`).
- `GET /ui/stickers` · `GET /ui/stickers/:key/file` · `POST /ui/stickers/:key/use` · `DELETE /ui/stickers/:key` — repertório de figurinhas (`use` devolve o anexo pronto para enviar).
- `POST /ui/threads/:id/media-actions` — `{ command, args?, mediaRef?, key?, url?, prompt? }`. Comandos: `sticker`, `fsticker`, `csticker`, `optimize`, `removebg`, `toimg`, `convert`, `save_sticker`, `gerar` e downloads (`youtube`, `twitter`, `instagram`, `reddit`, `tiktok`, `facebook`, `download`, `thumbnail`). `mediaRef` = `mediaId`, id de mensagem (`u-…`, `u-…#1`) ou vazio (última mídia da conversa). O resultado chega pelo stream como mensagem.

### Comandos digitados

Mensagens que começam com o prefixo (`COMMAND_PREFIX`, padrão `.`) rodam direto, sem LLM, como no WhatsApp:
`.sticker [10s]`, `.fsticker`, `.csticker`, `.toimg`, `.optimize`, `.removebg [cor] [leve|media|forte]`,
`.convert <formato>`, `.gerar <prompt>`, `.yt|.x|.insta|.rd|.tk|.fb|.dl <link> [mp3|mp4] [full|mid|low]`,
`.repertorio on|off|listar|salvar [chave]|remover <chave>` e `.help`. A mídia alvo é o anexo da própria
mensagem ou a última mídia da conversa.

### Ações do agente

As ações que o LLM emite (`sticker("chave")`, `sticker("<message_id>")`, `fsticker`, `csticker`, `toimg`, `removebg`,
`optimize`, `convert`, downloads por link, `gerarImagem`, `salvarSticker`, `modoRepertorio`, `reagir`) são executadas na UI:
figurinhas/mídias viram bolhas com anexo e `reagir("❤️")` vira `meta.reaction` na última mensagem do usuário.
Anexos do usuário entram no prompt como `[anexo: imagem (message_id: u-…)]`, e o primeiro vai ao pipeline como
`media` (com descrição visual quando a visão está habilitada).

Arquivos ficam em `data/media/ui/` (`TETOS_UI_MEDIA_PATH`).
