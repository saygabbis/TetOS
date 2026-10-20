/** Detecta e extrai conteúdo de mensagens view-once (visualização única). */

export function isViewOnceStub(incoming = {}) {
  if (incoming?.key?.isViewOnce) return true;
  const params = (incoming.messageStubParameters ?? []).map((p) => String(p ?? "").toLowerCase());
  if (params.some((p) => p.includes("absent from node") || p.includes("view once"))) return true;
  if (incoming.messageStubType && params.length && !incoming.message?.conversation) return true;
  return false;
}

export function extractViewOnceInner(rawMessage = {}) {
  const m = rawMessage ?? {};
  const wrapped =
    m.viewOnceMessageV2?.message ??
    m.viewOnceMessageV2Extension?.message ??
    m.viewOnceMessage?.message ??
    null;
  if (wrapped) return wrapped;

  if (
    m.imageMessage?.viewOnce ||
    m.videoMessage?.viewOnce ||
    m.audioMessage?.viewOnce
  ) {
    return m;
  }
  return null;
}

export function isViewOnceMessage(rawMessage = {}, incomingKey = {}) {
  if (incomingKey?.isViewOnce) return true;
  const m = rawMessage ?? {};
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) return true;
  const inner = extractViewOnceInner(rawMessage);
  return Boolean(inner?.imageMessage || inner?.videoMessage || inner?.audioMessage);
}

export function viewOnceMediaKind(inner = {}) {
  if (inner?.audioMessage) return "audio";
  if (inner?.imageMessage) return "image";
  if (inner?.videoMessage) return inner.videoMessage.gifPlayback ? "gif" : "video";
  return null;
}

export function viewOnceCaption(inner = {}, fallbackText = "") {
  const t = String(fallbackText ?? "").trim();
  const fromMedia =
    inner?.imageMessage?.caption ?? inner?.videoMessage?.caption ?? null;
  if (fromMedia) return fromMedia;
  return t || null;
}
