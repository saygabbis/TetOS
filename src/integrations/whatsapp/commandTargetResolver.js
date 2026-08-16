import { extractMessageContent, normalizeMessageContent } from "baileys";
import { probeStickerIsAnimated } from "../../core/media/stickerAnimation.js";
import { fileExtFromDocumentMessage } from "./mediaStore.js";
import { findMediaOnDisk } from "./agentMediaResolver.js";
import { extractContextInfo } from "./messageContext.js";

function unwrapMessage(message = {}) {
  const extracted = extractMessageContent(message);
  if (extracted) return extracted;
  const normalized = normalizeMessageContent(message);
  return normalized ?? message ?? {};
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
    if (/^video\//.test(mime) || /\.(mp4|webm|mov|m4v|mkv)$/.test(name)) return "video";
    if (/gif/.test(mime) || /\.gif$/.test(name)) return "gif";
  }
  return null;
}

function persistIdForIncoming(messageId, mediaType, fromDocument) {
  if (fromDocument) return `${messageId}-document`;
  if (mediaType === "gif") return `${messageId}-video`;
  return `${messageId}-${mediaType}`;
}

async function persistProtoMedia({
  message,
  persistId,
  persistMedia,
  downloadContentFromMessage,
  basePath
}) {
  const mediaType = detectMediaType(message);
  if (!mediaType || !persistId || typeof persistMedia !== "function") return null;

  const unwrapped = unwrapMessage(message);
  const content =
    mediaType === "image"
      ? (unwrapped.imageMessage ?? unwrapped.documentMessage)
      : mediaType === "video" || mediaType === "gif"
        ? (unwrapped.videoMessage ?? unwrapped.documentMessage)
        : mediaType === "audio"
          ? unwrapped.audioMessage
          : unwrapped.stickerMessage;
  if (!content) return null;

  const fromDocument = Boolean(unwrapped.documentMessage && content === unwrapped.documentMessage);
  const decryptMediaAs = fromDocument
    ? "document"
    : mediaType === "sticker"
      ? "sticker"
      : mediaType === "gif"
        ? "video"
        : mediaType;

  const path = await persistMedia({
    downloadContentFromMessage,
    content,
    type: mediaType === "gif" ? "video" : mediaType,
    id: persistId,
    basePath,
    preferredExt: unwrapped.documentMessage
      ? fileExtFromDocumentMessage(unwrapped.documentMessage)
      : null,
    decryptMediaAs
  });
  if (!path) return null;

  const isAnimatedHint =
    mediaType === "gif" ||
    unwrapped?.stickerMessage?.isAnimated === true ||
    unwrapped?.stickerMessage?.isAnimated === "true";
  const isAnimated =
    mediaType === "sticker" || mediaType === "gif"
      ? await probeStickerIsAnimated(path, { isAnimatedHint })
      : Boolean(isAnimatedHint);

  return {
    type: mediaType,
    path,
    isAnimated
  };
}

async function finalizeSelfMedia(media) {
  if (!media?.path || !media?.type) return null;
  if (media.type === "sticker") {
    const isAnimated = await probeStickerIsAnimated(media.path, {
      isAnimatedHint: media.isAnimated
    });
    return { ...media, isAnimated };
  }
  return media;
}

export async function resolveCommandTarget({
  incoming,
  remoteJid,
  userId = null,
  media,
  historyStore,
  persistMedia,
  downloadContentFromMessage,
  basePath
}) {
  const fromParam = await finalizeSelfMedia(media);
  if (fromParam) return { source: "self", media: fromParam };

  const incomingId = incoming?.key?.id ?? null;
  const incomingRoot = unwrapMessage(incoming?.message ?? {});

  if (incomingId && detectMediaType(incomingRoot) && basePath) {
    const fromDisk = findMediaOnDisk(basePath, incomingId);
    const diskMedia = await finalizeSelfMedia(fromDisk);
    if (diskMedia) return { source: "self", media: diskMedia };
  }

  if (incomingId && detectMediaType(incomingRoot)) {
    try {
      const selfType = detectMediaType(incomingRoot);
      const unwrapped = unwrapMessage(incomingRoot);
      const fromDocument = Boolean(
        unwrapped.documentMessage &&
          !unwrapped.imageMessage &&
          !unwrapped.videoMessage &&
          !unwrapped.audioMessage &&
          !unwrapped.stickerMessage
      );
      const selfMedia = await persistProtoMedia({
        message: incomingRoot,
        persistId: persistIdForIncoming(incomingId, selfType, fromDocument),
        persistMedia,
        downloadContentFromMessage,
        basePath
      });
      if (selfMedia?.path) return { source: "self", media: selfMedia };
    } catch {
      // tenta quoted
    }
  }

  const contextInfo = extractContextInfo(incomingRoot);
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
      const fromDocument =
        quotedContent.documentMessage && content === quotedContent.documentMessage;
      const decryptMediaAs = fromDocument
        ? "document"
        : quotedType === "sticker"
          ? "sticker"
          : quotedType === "gif"
            ? "video"
            : quotedType;
      const path = await persistMedia({
        downloadContentFromMessage,
        content,
        type: quotedType === "gif" ? "video" : quotedType,
        id: `${incoming.key.id}-quoted-${quotedType}`,
        basePath,
        preferredExt: quotedContent.documentMessage ? fileExtFromDocumentMessage(quotedContent.documentMessage) : null,
        decryptMediaAs
      });
      const isStickerAnim = await probeStickerIsAnimated(path, {
        isAnimatedHint:
          quotedType === "gif" ||
          stickerMsg?.isAnimated === true ||
          stickerMsg?.isAnimated === "true"
      });
      return {
        source: "reply",
        media: {
          type: quotedType,
          path,
          isAnimated: isStickerAnim
        }
      };
    } catch {
      // sem reply válido
    }
  }

  return { source: "none", media: null };
}
