import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { probeStickerIsAnimated } from "../../core/media/stickerAnimation.js";

export function normAgentMessageId(id) {
  return String(id ?? "")
    .trim()
    .replace(/^\[?ID:\s*/i, "")
    .replace(/\]$/, "")
    .trim();
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
      type: entry.mediaType ?? suffixToMediaType(fileName.match(/-(sticker|image|video|audio|document)\./i)?.[1]) ?? "sticker",
      path: abs
    };
  }
  return null;
}

function resolveMediaPath(mediaPath, basePath = "./data/media") {
  const raw = String(mediaPath ?? "").trim();
  if (!raw) return null;
  const abs = raw.includes(":") || raw.startsWith("/") || /^[a-zA-Z]:\\/.test(raw)
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

/**
 * Resolve mídia de uma mensagem pelo message id para comandos do agente (toimage, etc.).
 */
export async function resolveMediaByMessageId({
  messageId,
  chatId,
  mediaHistoryStore = null,
  basePath = "./data/media",
  visualAnalyses = null
} = {}) {
  const mid = normAgentMessageId(messageId);
  if (!mid) return null;

  const fromHistory = mediaHistoryStore?.findByMessageId?.(chatId, mid);
  const historyMedia = normalizeResolvedMedia(fromHistory?.media, basePath);
  if (historyMedia) {
    return { source: "history", media: historyMedia };
  }

  const fromDisk = findMediaOnDisk(basePath, mid);
  if (fromDisk?.path) {
    if (fromDisk.type === "sticker" && fromDisk.isAnimated === undefined) {
      fromDisk.isAnimated = await probeStickerIsAnimated(fromDisk.path);
    }
    return { source: "disk", media: fromDisk };
  }

  const fromVisual = mediaFromVisualAnalyses(visualAnalyses, mid, basePath);
  if (fromVisual?.path) {
    if (fromVisual.type === "sticker") {
      fromVisual.isAnimated = await probeStickerIsAnimated(fromVisual.path);
    }
    return { source: "visual", media: fromVisual };
  }

  return null;
}
