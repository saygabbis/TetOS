Pasta de stickers .webp usados pela TetOS.

Arquivos presentes atualmente:
- teto-linguinha.webp
- teto-pao.webp
- teto-saliente.webp

O fluxo passivo de sticker-only usa `resolveStickerAsset()` e procura, nesta ordem:
- a chave solicitada pelo planner, normalmente `ack`
- ack.webp
- ok.webp
- thumbs_up.webp
- heart.webp

Para o sticker-only passivo funcionar sem mexer no código, adicione pelo menos `ack.webp` nesta pasta ou ajuste o planner para usar uma das chaves `teto-*`.

A resolução do asset usa `TETOS_STICKERS_PATH`; o padrão é `./data/stickers`.
