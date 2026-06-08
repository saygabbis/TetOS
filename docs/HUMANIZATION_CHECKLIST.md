# Checklist de humanização — Teto IA Viva

Validado via testes automatizados (`npm run test:brain:all`) + wiring no código.

- [x] Fila por `sessionId` (DM ≠ grupo) — `test-response-processor-sessions.js`
- [x] `closeDecision` respeitado end-to-end — `test-chat-closure.js`
- [x] Mídia repassada ao pipeline — `test-media-learning.js` + `messagePipeline.js`
- [x] Grupo: memória persistente + recall por gatilho — `test-group-memory.js`, `test-group-context.js`
- [x] Timing com razões logadas (`mind:watch`) — `test-timing-checks-count.js`, `test-mind-logger.js`
- [x] Sem resposta pré-gerada (exceto `[SEM_RESPOSTA]`) — `nudgeEngine.js` intent-only + agent slim
- [x] Trust/intimacy evolui lentamente — `test-trust-intimacy.js`
- [x] Machine Love surge naturalmente em papo musical — `test-music-research.js` + `MusicWorld`
- [x] Relatório diário com timeline horária — `test-reports-hourly.js` + `hourlySnapshots`
- [x] Ativação `/teto-ativar` e `/teto-grupo-ativar` — `test-teto-activation.js`
- [x] WorldContext v2 viagens raras autônomas — `test-world-context-v2.js`
- [ ] Teste manual no Zap — ver `docs/MANUAL_TEST_WA.md`
