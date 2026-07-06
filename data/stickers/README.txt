Pasta de stickers .webp usados pela TetOS.

## Dois fluxos

### 1. Sticker-only passivo (`react_only`)

O planner pede a chave `ack`. `resolveStickerAsset()` procura, nesta ordem:

- `ack.webp`
- `ok.webp`
- `thumbs_up.webp`
- `heart.webp`

Para esse fluxo funcionar sem alterar código, adicione pelo menos `ack.webp` nesta pasta.

### 2. Repertório do agente

Figurinhas salvas em `data/stickers/*.webp` com metadados em `catalog.json`.

- Chaves aprendidas (ex.: `teto-mill-jardas.webp`) entram no catálogo automaticamente.
- O agente envia com `sticker("chave")` na resposta.
- Auto-save liga com `modoRepertorio("on")` por usuário.
- Salva manual com `salvarSticker("message_id")`.

## Configuração

- `TETOS_STICKERS_PATH` — pasta desta pasta (padrão `./data/stickers`)
- `TETOS_STICKER_REPERTOIRE_MODE_PATH` — estado do modo repertório (padrão `./data/stickerRepertoireMode.json`)
