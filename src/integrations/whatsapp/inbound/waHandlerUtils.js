// Utilitários compartilhados entre o handler de mensagens e o orquestrador de conversa.

export function extractPhone(remoteJid = "") {
  return String(remoteJid)
    .replace(/@.+$/, "")
    .replace(/:\d+$/, "");
}

export function isWaConnectionError(error) {
  const msg = String(error?.message ?? error ?? "");
  const status = error?.output?.statusCode ?? error?.output?.payload?.statusCode ?? null;
  return (
    /connection closed/i.test(msg) ||
    /connection was lost/i.test(msg) ||
    /connection lost/i.test(msg) ||
    status === 428 ||
    status === 408
  );
}

export function logThinking(runtime, payload = {}) {
  const {
    phase = "unknown",
    userId = "unknown",
    remoteJid = "unknown",
    detail = ""
  } = payload;
  const detailText = String(detail ?? "").trim();
  if (!runtime?.defaults?.thinkingLogsEnabled) return;
  console.log(
    `[thinking] phase=${phase} user=${userId} chat=${remoteJid}${detailText ? ` detail="${detailText}"` : ""}`
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Anexa o resultado da visão (descrição) aos campos de mídia. */
export function applyVisionFields(media, visualDescription, { skipVision = false } = {}) {
  if (!media) return media;
  const attempted = !skipVision && Boolean(media.path);
  return {
    ...media,
    transcript: (typeof visualDescription === "string" && visualDescription) || (typeof media.transcript === "string" ? media.transcript : null),
    visionAttempted: attempted,
    visionStatus: !attempted ? undefined : visualDescription ? "ok" : "failed"
  };
}
