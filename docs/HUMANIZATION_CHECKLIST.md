# Humanization Validation Checklist

Use this checklist after updating conversation behavior.

## Scenario tests

- Context carry-over without repeated keywords:
  - User starts topic A.
  - User follows with indirect reference (no topic nouns).
  - Expected: assistant keeps topic A correctly.
- Abrupt topic change:
  - User jumps from casual chat to technical question.
  - Expected: assistant follows the new topic without forgetting user profile.
- Burst handling:
  - User sends 2-4 short messages in sequence.
  - Expected: assistant waits for burst and answers in order.
- Persona stability:
  - User asks neutral, playful, and sensitive messages.
  - Expected: same persona voice, but calmer in sensitive context.
- Multi-message naturalness:
  - Ask a complex question requiring 2-3 message chunks.
  - Expected: chunks are coherent and not over-split.

## Calibration metrics

- Context correctness: target >= 90%
- Ordered replies in burst: target 100%
- Useful multi-message rate on long replies: target 60-80%
- Repetition regressions: target <= 10%
- Persona drift incidents: target <= 5%
- Caricature incidents (too many typos/corrections): target <= 3%

## Imperfection guardrails

- Max typo/self-correction event: 1 per 10 minutes per user.
- Disable imperfection in calm/sensitive conversations.
- Never inject imperfection if message may reduce comprehension.

## Tuning knobs

- `USER_BATCH_WINDOW_MS` in `messageHandler.js`:
  - Lower value: faster replies, less burst aggregation.
  - Higher value: slower replies, better aggregation.
- Typing pacing constants in `messageHandler.js`:
  - `TYPING_MIN_DELAY_MS`
  - `TYPING_MAX_DELAY_MS`
  - `TYPING_CHARS_PER_SECOND`
- Imperfection controls in `responseProcessor.js`:
  - `maxImperfectionsPerWindow`
  - `imperfectionWindowMs`
