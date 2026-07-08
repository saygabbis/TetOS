const recentMediaByUser = new Map();
const BURST_WINDOW_MS = 45_000;
const BURST_MAX = 4;

/** Mídia visual/áudio sem legenda — vale responder se houver conteúdo ou endereço. */
export function shouldRespondToMediaOnly({
  media = null,
  isDirect = false,
  isReply = false,
  isReplyToBot = false,
  hasVisionOrTranscript = false,
  userId = null
} = {}) {
  if (!media?.type) return false;
  if (isReply || isReplyToBot || isDirect) return true;
  if (hasVisionOrTranscript) return true;
  if (isMediaSpamBurst(userId, media)) return false;
  const visualTypes = new Set(["image", "sticker", "gif", "video"]);
  if (visualTypes.has(media.type)) return true;
  if (media.type === "audio") return Boolean(media.transcript);
  return false;
}

export function isMediaSpamBurst(userId, media = null) {
  const uid = String(userId ?? "").trim();
  if (!uid) return false;
  const key = `${uid}::${media?.type ?? "media"}::${media?.path ?? ""}`;
  const now = Date.now();
  const prev = recentMediaByUser.get(uid) ?? [];
  const fresh = prev.filter((e) => now - e.at < BURST_WINDOW_MS);
  fresh.push({ key, at: now });
  recentMediaByUser.set(uid, fresh);
  const same = fresh.filter((e) => e.key === key);
  return same.length >= BURST_MAX;
}

export function isMediaPlaceholderOnly(text = "", media = null) {
  const t = String(text ?? "").trim();
  if (t && !/^\[(sticker|image|video|gif|audio|media|figurinha|imagem)\]$/i.test(t)) {
    return false;
  }
  return !String(media?.transcript ?? "").trim();
}
