# Checklist de Humanização - Teto IA Viva

Validado por testes automatizados e wiring no código.

- [x] Fila por `sessionId` (DM diferente de grupo) - `test-response-processor-sessions.js`.
- [x] `closeDecision` respeitado end-to-end - `test-chat-closure.js`.
- [x] Mídia repassada ao pipeline - `test-media-learning.js` e `messagePipeline.js`.
- [x] Grupo com memória persistente e recall por gatilho - `test-group-memory.js`, `test-group-context.js`.
- [x] Timing com razões logadas em `mind:watch` - `test-timing-checks-count.js`, `test-mind-logger.js`.
- [x] Sem resposta pré-gerada fora dos fluxos permitidos - `nudgeEngine.js`, agent slim e `[SEM_RESPOSTA]`.
- [x] Trust/intimacy evolui lentamente - `test-trust-intimacy.js`.
- [x] Machine Love surge naturalmente em papo musical - `test-music-research.js` e `MusicWorld`.
- [x] Relatório diário com timeline horária - `test-reports-hourly.js` e `hourlySnapshots`.
- [x] Ativação `/teto-ativar` e `/teto-grupo-ativar` - `test-teto-activation.js`.
- [x] WorldContext v2 com viagens raras/autônomas - `test-world-context-v2.js`.
- [x] Comandos de mídia integrados ao WhatsApp - `messageHandler.js`.
- [ ] Teste manual no WhatsApp - ver `docs/MANUAL_TEST_WA.md`.
