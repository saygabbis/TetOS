# Teto - Extensões e Adapters

Este documento resume os pontos de extensão configuráveis no runtime atual.

| Variável | Adapter / recurso | Uso no runtime |
| --- | --- | --- |
| `TETOS_LLM_PROVIDER` | `ollama` ou `minimax` | Seleciona o cliente principal de geração |
| `TETOS_OLLAMA_MODE` | `local` ou `cloud` | Define base URL/modelo padrão do Ollama |
| `TETOS_OLLAMA_URL` | Ollama local | `ollamaClient` |
| `TETOS_OLLAMA_CLOUD_URL` | Ollama Cloud | `ollamaClient` em modo cloud |
| `TETOS_OLLAMA_API_KEY` / `OLLAMA_API_KEY` | Chave Ollama Cloud | Autenticação cloud |
| `TETOS_MINIMAX_API_KEY` | MiniMax API | `minimaxClient` |
| `TETOS_MINIMAX_MODEL` | Modelo MiniMax | Modelo principal no provider `minimax` |
| `TETOS_MINIMAX_WORKER_MODEL` | Modelo worker MiniMax | Worker de narração/resumos quando aplicável |
| `TETOS_VISION_ADAPTER` | BLIP / LLaVA / API | `MediaLearningHub`, `SemanticVisionAnalyzer` |
| `TETOS_VIDEO_ADAPTER` | `ffmpeg_frames` | Análise multi-frame de vídeo/GIF |
| `TETOS_WEB_READER_ENABLED` | Search + read URL | `MusicWorld`, `AutonomousEvolution`, busca |
| `TETOS_WORKER_LLM_URL` / `TETOS_WORKER_LLM_MODEL` | Worker LLM | `LifeNarrator`, pensamentos solo e rotina |
| `TETOS_AUDIO_TRANSCRIBER` | Whisper / API | Transcrição de áudio do WhatsApp |
| `TETO_WEATHER_ADAPTER` | opcional | `WorldContext` com clima real |
| `REMOVEBG_API_KEY` / `REMOVEBG_API_KEYS` | remove.bg | `.removebg` em imagem/figurinha estática |
| `TETOS_REMOVEBG_MODEL` | `small`, `medium`, `large` | Modelo local/API para remoção de fundo |

## AdapterRegistry

Arquivo: `src/core/adapters/AdapterRegistry.js`

Métodos relevantes:

- `analyze()` - visão/mídia.
- `search()` - busca web/música.
- `summarize()` - resumos worker.
- `readUrl()` - leitura de páginas.
- `complete()` - completações auxiliares.

## WhatsApp e Mídia

Arquivos principais:

- `src/integrations/whatsapp/runner.js`
- `src/integrations/whatsapp/messageHandler.js`
- `src/integrations/whatsapp/commandTargetResolver.js`
- `src/core/media/mediaProcessor.js`
- `src/core/media/backgroundRemovalService.js`

Comandos atuais:

- `.sticker`
- `.fsticker`
- `.csticker`
- `.toimg`
- `.removebg`
- `.optimize`
- `.help`

## Camadas A/B/C

- **A determinística:** subsistemas, seeds, JSON e estado persistido.
- **B heurística:** `TimingEngine`, trust, memória, fase conversacional e políticas de canal.
- **C worker LLM:** turnos-chave, narração de vida, pensamentos solo e resumos.

A camada C depende de `TETOS_WORKER_LLM_URL` e `TETOS_WORKER_LLM_MODEL`.
