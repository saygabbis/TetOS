import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeMessageContent } from "baileys";
import { probeStickerIsAnimated } from "../../core/media/stickerAnimation.js";
import { fileExtFromDocumentMessage, persistMedia } from "./mediaStore.js";
import { extractContextInfo } from "./messageContext.js";

export function normAgentMessageId(id) {
  return String(id ?? "")
    .trim()
    .replace(/^\[?ID:\s*/i, "")
    .replace(/\]$/, "")
    .trim();
}

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

function persistIdForMediaType(messageId, mediaType) {
  if (mediaType === "sticker") return `${messageId}-sticker`;
  if (mediaType === "gif") return `${messageId}-video`;
  return `${messageId}-${mediaType}`;
}

async function persistMediaFromProto({
  messageProto,
  messageId,
  basePath,
  downloadContentFromMessage
}) {
  const mediaType = detectMediaType(messageProto);
  if (!mediaType || !messageId) return null;

  const quotedContent = unwrapMessage(messageProto);
  const content =
    mediaType === "image"
      ? (quotedContent.imageMessage ?? quotedContent.documentMessage)
      : mediaType === "video" || mediaType === "gif"
        ? (quotedContent.videoMessage ?? quotedContent.documentMessage)
        : mediaType === "audio"
          ? quotedContent.audioMessage
          : quotedContent.stickerMessage;
  if (!content) return null;

  const stickerMsg = quotedContent?.stickerMessage;
  const fromDocument =
    quotedContent.documentMessage && content === quotedContent.documentMessage;
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
    id: persistIdForMediaType(messageId, mediaType),
    basePath,
    preferredExt: quotedContent.documentMessage
      ? fileExtFromDocumentMessage(quotedContent.documentMessage)
      : null,
    decryptMediaAs
  });
  if (!path) return null;

  const isAnimated = await probeStickerIsAnimated(path, {
    isAnimatedHint:
      mediaType === "gif" ||
      mediaType === "sticker" ||
      stickerMsg?.isAnimated === true ||
      stickerMsg?.isAnimated === "true"
  });

  return {
    type: mediaType === "gif" ? "gif" : mediaType,
    path,
    isAnimated
  };
}

function suffixToMediaType(suffix) {
  const s = String(suffix ?? "").toLowerCase();
  if (s === "sticker") return "sticker";
  if (s === "image") return "image";
  if (s === "video") return "video";
  if (s === "audio") return "audio";
  if (s === "document") return "image";
  return null;
}

/** Procura arquivo persistido em data/media pelo message id (ex.: 3EB0…-sticker.webp). */
export function findMediaOnDisk(basePath, messageId) {
  const mid = normAgentMessageId(messageId);
  if (!mid || !basePath) return null;
  const prefix = `${mid}-`;
  let files = [];
  try {
    files = readdirSync(basePath);
  } catch {
    return null;
  }
  const matches = files.filter((name) => name.startsWith(prefix));
  if (!matches.length) return null;

  const ordered = [
    ...matches.filter((name) => /-sticker\./i.test(name)),
    ...matches.filter((name) => !/-sticker\./i.test(name))
  ];

  for (const file of ordered) {
    const suffixMatch = file.match(/^.+?-(sticker|image|video|audio|document)\.([a-z0-9]+)$/i);
    if (!suffixMatch) continue;
    const type = suffixToMediaType(suffixMatch[1]);
    if (!type) continue;
    const path = join(basePath, file);
    if (!existsSync(path)) continue;
    return { type, path, isAnimated: type === "sticker" ? undefined : false };
  }
  return null;
}

function mediaFromVisualAnalyses(visualAnalyses, messageId, basePath) {
  const mid = normAgentMessageId(messageId);
  if (!mid || !visualAnalyses?.data?.entries?.length) return null;
  for (let i = visualAnalyses.data.entries.length - 1; i >= 0; i -= 1) {
    const entry = visualAnalyses.data.entries[i];
    const mediaPath = String(entry?.mediaPath ?? "");
    if (!mediaPath.includes(mid)) continue;
    const fileName = mediaPath.split(/[/\\]/).pop() ?? "";
    if (!fileName.startsWith(`${mid}-`)) continue;
    const abs = mediaPath.includes(":") || mediaPath.startsWith("/")
      ? mediaPath
      : join(process.cwd(), mediaPath);
    if (!existsSync(abs)) continue;
    return {
      type:
        entry.mediaType ??
        suffixToMediaType(fileName.match(/-(sticker|image|video|audio|document)\./i)?.[1]) ??
        "sticker",
      path: abs
    };
  }
  return null;
}

function resolveMediaPath(mediaPath, basePath = "./data/media") {
  const raw = String(mediaPath ?? "").trim();
  if (!raw) return null;
  const abs =
    raw.includes(":") || raw.startsWith("/") || /^[a-zA-Z]:\\/.test(raw)
      ? resolve(raw)
      : resolve(process.cwd(), raw);
  if (existsSync(abs)) return abs;
  const fileName = raw.split(/[/\\]/).pop();
  if (fileName) {
    const fromBase = join(resolve(basePath), fileName);
    if (existsSync(fromBase)) return fromBase;
  }
  return null;
}

function normalizeResolvedMedia(media, basePath) {
  if (!media?.path) return null;
  const path = resolveMediaPath(media.path, basePath);
  if (!path) return null;
  return { ...media, path };
}

async function finalizeStickerMedia(media) {
  if (!media?.path) return null;
  if (media.type === "sticker" && media.isAnimated === undefined) {
    media.isAnimated = await probeStickerIsAnimated(media.path);
  }
  return media;
}

async function resolveFromWaStoredMessage(stored, targetId, deps) {
  if (!stored?.message || normAgentMessageId(stored.key?.id) !== targetId) return null;
  const media = await persistMediaFromProto({
    messageProto: stored.message,
    messageId: targetId,
    ...deps
  });
  if (!media) return null;
  return { source: "wa_cache", media: await finalizeStickerMedia(media) };
}

async function resolveFromTriggerQuotedMessage(storedTrigger, targetId, deps) {
  if (!storedTrigger?.message) return null;
  const root = unwrapMessage(storedTrigger.message);
  const ctx = extractContextInfo(root);
  if (normAgentMessageId(ctx?.stanzaId) !== targetId || !ctx?.quotedMessage) return null;
  const media = await persistMediaFromProto({
    messageProto: ctx.quotedMessage,
    messageId: targetId,
    ...deps
  });
  if (!media) return null;
  return { source: "wa_quote", media: await finalizeStickerMedia(media) };
}

/**
 * Resolve mídia de uma mensagem pelo message id para comandos do agente (toimage, etc.).
 */
export async function resolveMediaByMessageId({
  messageId,
  chatId,
  mediaHistoryStore = null,
  basePath = "./data/media",
  visualAnalyses = null,
  getWaMessageById = null,
  triggerMessageId = null,
  downloadContentFromMessage = null
} = {}) {
  const mid = normAgentMessageId(messageId);
  if (!mid) return null;

  const fromHistory = mediaHistoryStore?.findByMessageId?.(chatId, mid);
  const historyMedia = normalizeResolvedMedia(fromHistory?.media, basePath);
  if (historyMedia) {
    return { source: "history", media: await finalizeStickerMedia(historyMedia) };
  }

  const fromDisk = findMediaOnDisk(basePath, mid);
  if (fromDisk?.path) {
    return { source: "disk", media: await finalizeStickerMedia(fromDisk) };
  }

  const fromVisual = mediaFromVisualAnalyses(visualAnalyses, mid, basePath);
  if (fromVisual?.path) {
    return { source: "visual", media: await finalizeStickerMedia(fromVisual) };
  }

  const waDeps =
    downloadContentFromMessage && basePath
      ? { basePath, downloadContentFromMessage }
      : null;

  if (waDeps && typeof getWaMessageById === "function") {
    const direct = await resolveFromWaStoredMessage(getWaMessageById(mid), mid, waDeps);
    if (direct?.media?.path) {
      // #region agent log
      fetch('http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'928ed5'},body:JSON.stringify({sessionId:'928ed5',runId:'post-fix',location:'agentMediaResolver.js:resolve',message:'media resolved wa_cache',data:{messageId:mid,source:'wa_cache',mediaType:direct.media.type},timestamp:Date.now(),hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      return direct;
    }

    const triggerId = normAgentMessageId(triggerMessageId);
    if (triggerId) {
      const fromQuote = await resolveFromTriggerQuotedMessage(
        getWaMessageById(triggerId),
        mid,
        waDeps
      );
      if (fromQuote?.media?.path) {
        // #region agent log
        fetch('http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'928ed5'},body:JSON.stringify({sessionId:'928ed5',runId:'post-fix',location:'agentMediaResolver.js:resolve',message:'media resolved wa_quote',data:{messageId:mid,triggerId,source:'wa_quote',mediaType:fromQuote.media.type},timestamp:Date.now(),hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        return fromQuote;
      }
    }
  }

  // #region agent log
  fetch('http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'928ed5'},body:JSON.stringify({sessionId:'928ed5',runId:'post-fix',location:'agentMediaResolver.js:resolve',message:'media not found',data:{messageId:mid,chatId,hadWaFallback:Boolean(waDeps&&getWaMessageById),triggerMessageId:triggerMessageId??null},timestamp:Date.now(),hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  return null;
}
