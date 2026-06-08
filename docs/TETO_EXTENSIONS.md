# Teto — Extensões e adapters

| Variável | Adapter | Uso no runtime |
|----------|---------|----------------|
| `TETOS_VISION_ADAPTER` | BLIP / llava / API | `MediaLearningHub.analyze`, `SemanticVisionAnalyzer` |
| `TETOS_VIDEO_ADAPTER` | ffmpeg_frames | Multi-frame vídeo/GIF → hub |
| `TETOS_WEB_READER_ENABLED` | Search + read URL | `MusicWorld.research`, `AutonomousEvolution` |
| `TETOS_WORKER_LLM_URL` / `TETOS_WORKER_LLM_MODEL` | Ollama worker | `LifeNarrator.narrate`, `soloThoughts`, rotina |
| `TETOS_AUDIO_TRANSCRIBER` | Whisper / API | Transcrição áudio WA |
| `TETOS_EMBEDDING_API` | futuro | Memória semântica episódica |
| `TETO_WEATHER_ADAPTER` | opcional | `WorldContext` clima real |

## AdapterRegistry (`src/core/adapters/AdapterRegistry.js`)

- `analyze()` — visão multi-frame
- `search()` — web/música
- `summarize()` — resumos worker
- `readUrl()` — leitor de páginas

## Grill LLM A/B/C

- **A** determinístico: subsistemas, seeds, JSON
- **B** heurística: TimingEngine 50+ checks, trust, memória
- **C** worker LLM: turnos-chave (vulnerável, menção, madrugada, intimidade alta)

Camada C só quando `TETOS_WORKER_LLM_URL` configurado.
