export const RESPONSE_MODES = Object.freeze({
  FULL: "full",
  REACT_ONLY: "react_only",
  STICKER_ONLY: "sticker_only",
  LEARN_ONLY: "learn_only",
  BLOCKED: "blocked",
  USER_BOUNDARY_SET: "user_boundary_set",
  USER_BOUNDARY: "user_boundary",
  SLEEP_HOLD: "sleep_hold",
  MEDIA_WAIT: "media_wait",
  BUSY_ACK: "busy_ack",
  BUSY_HOLD: "busy_hold",
  TIMING_SILENCE: "timing_silence"
});

export const RESPONSE_OUTPUTS = Object.freeze({
  TEXT: "text",
  REACTION: "reaction",
  STICKER: "sticker",
  SILENT: "silent",
  COMMAND: "command",
  IGNORED: "ignored"
});

export function isPassiveResponseMode(mode) {
  return mode === RESPONSE_MODES.REACT_ONLY || mode === RESPONSE_MODES.STICKER_ONLY;
}
