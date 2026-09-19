/** Constantes de timing — lidas do runtime.defaults (.env). */
export function resolveTimingConfig(defaults = {}) {
  return {
    batchWindowMs: Number(defaults.batchWindowMs ?? 1200),
    groupBatchWindowMs: Number(defaults.groupBatchWindowMs ?? 2200),
    mediaHoldMs: Number(defaults.mediaHoldMs ?? 5000),
    typingGraceMs: Number(defaults.typingGraceMs ?? 2400),
    typingMinDelayMs: Number(defaults.typingMinDelayMs ?? 140),
    typingMaxDelayMs: Number(defaults.typingMaxDelayMs ?? 2400),
    followupTypingMinDelayMs: Number(defaults.followupTypingMinDelayMs ?? 500),
    followupGapMinMs: 60,
    followupGapMaxMs: 160,
    multiPartDelayMinMs: 120,
    multiPartDelayMaxMs: 380,
    firstBubbleTypingFloorMs: 480,
    postModelBeforeBubbleMinMs: 90,
    postModelBeforeBubbleMaxMs: 240,
    interruptDebounceMinMs: 120,
    interruptDebounceMaxMs: 260,
    modelTimeoutMs: Number(defaults.modelTimeoutMs ?? 25000),
    typingSqrtRefLen: 220
  };
}

export function estimateTypingDelayMs(text, partIndex = 0, cfg = {}) {
  const min = cfg.typingMinDelayMs ?? 140;
  const max = cfg.typingMaxDelayMs ?? 2400;
  const ref = cfg.typingSqrtRefLen ?? 220;
  const len = String(text ?? "").trim().length;
  if (len <= 0) return min;
  const span = max - min;
  const ratio = Math.sqrt(len) / Math.sqrt(ref);
  const blended = min + Math.min(1, ratio) * span;
  const partWave = 1 + (partIndex % 2 === 0 ? 0.05 : 0.14);
  const rng = typeof cfg.random === "function" ? cfg.random : Math.random;
  const jitter = 0.82 + rng() * 0.34;
  const ms = blended * partWave * jitter;
  return Math.round(Math.min(max, Math.max(min, ms)));
}

/**
 * Delay de digitação das bolhas depois da primeira.
 * Curto → perto de 0,5s; longo → teto atual (`typingMaxDelayMs`).
 */
export function estimateFollowupTypingDelayMs(text, cfg = {}) {
  const min = Math.max(0, Number(cfg.followupTypingMinDelayMs ?? 500));
  const max = Math.max(min, Number(cfg.typingMaxDelayMs ?? 2400));
  const ref = Math.max(1, Number(cfg.followupTypingRefLen ?? cfg.typingSqrtRefLen ?? 220));
  const len = String(text ?? "").trim().length;
  if (len <= 0) return Math.round(min);
  const ratio = Math.min(1, len / ref);
  const blended = min + ratio * (max - min);
  const rng = typeof cfg.random === "function" ? cfg.random : Math.random;
  const jitter = 0.92 + rng() * 0.16;
  return Math.round(Math.min(max, Math.max(min, blended * jitter)));
}
