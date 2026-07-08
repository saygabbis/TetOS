import { normalizeMessageContent } from "baileys";
import { probeStickerIsAnimated } from "../../core/media/stickerAnimation.js";
import { fileExtFromDocumentMessage } from "./mediaStore.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { looksLikeGifFile } from "../../core/media/gifToMp4Encoder.js";

function unwrapMessage(message = {}) {
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
  if (media?.path && media?.type) {
    if (media.type === "sticker") {
      const isAnimated = await probeStickerIsAnimated(media.path, {
        isAnimatedHint: media.isAnimated
      });
      return { source: "self", media: { ...media, isAnimated } };
    }
    return { source: "self", media };
  }

  const incomingRoot = unwrapMessage(incoming?.message ?? {});
  const contextInfo = incomingRoot?.extendedTextMessage?.contextInfo;
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
      // #region agent log
      try {
        const head = existsSync(path) ? readFileSync(path, { start: 0, end: 5 }).toString("ascii") : "";
        fetch("http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "20737f" },
          body: JSON.stringify({
            sessionId: "20737f",
            hypothesisId: "H1-H2",
            location: "commandTargetResolver.js:persist",
            message: "convert target resolved from reply",
            data: {
              quotedType,
              fromDocument,
              decryptMediaAs,
              path,
              ext: extname(path),
              sizeBytes: existsSync(path) ? statSync(path).size : 0,
              headSig: head,
              looksLikeGif: looksLikeGifFile(path),
              docMime: quotedContent.documentMessage?.mimetype ?? null,
              docName: quotedContent.documentMessage?.fileName ?? null
            },
            timestamp: Date.now()
          })
        }).catch(() => {});
      } catch {}
      // #endregion
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
      // fallback to history below
    }
  }

  const fallback = historyStore.latest(remoteJid, userId);
  if (fallback?.media?.path) {
    const isAnimated = await probeStickerIsAnimated(fallback.media.path, {
      isAnimatedHint: fallback.media.isAnimated
    });
    return {
      source: "history",
      media: { ...fallback.media, isAnimated }
    };
  }

  return { source: "none", media: null };
}
