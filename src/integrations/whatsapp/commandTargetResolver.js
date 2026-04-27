function unwrapMessage(message = {}) {
  const viewOnce = message?.viewOnceMessage?.message;
  const ephemeral = message?.ephemeralMessage?.message;
  const wrapped = viewOnce ?? ephemeral;
  if (wrapped) return unwrapMessage(wrapped);
  return message;
}

function detectMediaType(message = {}) {
  const unwrapped = unwrapMessage(message);
  if (unwrapped?.imageMessage) return "image";
  if (unwrapped?.videoMessage?.gifPlayback) return "gif";
  if (unwrapped?.videoMessage) return "video";
  if (unwrapped?.audioMessage) return "audio";
  if (unwrapped?.stickerMessage) return "sticker";
  const doc = unwrapped?.documentMessage;
  if (doc) {
    const mime = String(doc?.mimetype ?? "").toLowerCase();
    const name = String(doc?.fileName ?? "").toLowerCase();
    if (/^image\//.test(mime) || /\.(png|jpe?g|webp|gif)$/.test(name)) return "image";
    if (/^video\//.test(mime) || /\.(mp4|webm|mov)$/.test(name)) return "video";
    if (/gif/.test(mime) || /\.gif$/.test(name)) return "gif";
  }
  return null;
}

export async function resolveCommandTarget({
  incoming,
  remoteJid,
  media,
  historyStore,
  persistMedia,
  downloadContentFromMessage,
  basePath
}) {
  if (media?.path && media?.type) {
    return { source: "self", media };
  }

  const contextInfo = incoming?.message?.extendedTextMessage?.contextInfo;
  const quotedMessage = contextInfo?.quotedMessage;
  const quotedType = detectMediaType(quotedMessage);
  if (quotedMessage && quotedType && incoming?.key?.id) {
    const quotedContent = unwrapMessage(quotedMessage);
    const content =
      quotedType === "image"
        ? (quotedContent.imageMessage ?? quotedContent.documentMessage)
        : quotedType === "video" || quotedType === "gif"
          ? (quotedContent.videoMessage ?? quotedContent.documentMessage)
          : quotedType === "audio"
            ? quotedContent.audioMessage
            : quotedContent.stickerMessage;
    try {
      const stickerMsg = quotedContent?.stickerMessage;
      const path = await persistMedia({
        downloadContentFromMessage,
        content,
        type: quotedType === "gif" ? "video" : quotedType,
        id: `${incoming.key.id}-quoted-${quotedType}`,
        basePath
      });
      const isStickerAnim =
        quotedType === "gif" || Boolean(stickerMsg?.isAnimated === true || stickerMsg?.isAnimated === "true");
      return {
        source: "reply",
        media: {
          type: quotedType,
          path,
          isAnimated: isStickerAnim
        }
      };
    } catch {
      // fallback to history below
    }
  }

  const fallback = historyStore.latest(remoteJid);
  if (fallback?.media?.path) {
    return { source: "history", media: fallback.media };
  }

  return { source: "none", media: null };
}
