import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const DOC_EXT_ALLOW = new Set(["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "m4v", "mkv"]);

/**
 * Extensão de arquivo sugerida para mídia baixada de `documentMessage` (evita .mp4 em GIF, etc.).
 */
export function fileExtFromDocumentMessage(doc) {
  if (!doc) return null;
  const name = String(doc.fileName ?? "").toLowerCase();
  const fromName = name.match(/\.([a-z0-9]+)$/i);
  if (fromName) {
    const e = fromName[1].toLowerCase();
    if (DOC_EXT_ALLOW.has(e)) return e === "jpeg" ? "jpg" : e;
  }
  const mime = String(doc.mimetype ?? "").toLowerCase();
  if (mime === "image/gif") return "gif";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime.startsWith("image/")) return "jpg";
  if (mime === "video/webm") return "webm";
  if (mime.includes("quicktime") || mime === "video/quicktime") return "mov";
  if (mime === "video/x-matroska") return "mkv";
  if (mime === "video/x-m4v" || mime === "video/mp4") return "mp4";
  if (mime.startsWith("video/")) return "mp4";
  return null;
}

export async function persistMedia({
  downloadContentFromMessage,
  content,
  type,
  id,
  basePath = "./data/media",
  preferredExt = null,
  /** Tipo para `getMediaKeys` no Baileys; `documentMessage` exige `"document"`, não `"image"`/`"video"`. */
  decryptMediaAs = null
} = {}) {
  if (!content || !id) return null;
  ensureDir(basePath);
  const defaultExt =
    type === "image"
      ? "jpg"
      : type === "video"
        ? "mp4"
        : type === "audio"
          ? "ogg"
          : type === "sticker"
            ? "webp"
            : "bin";
  let ext = defaultExt;
  if (preferredExt) {
    const cleaned = String(preferredExt).replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (DOC_EXT_ALLOW.has(cleaned)) ext = cleaned === "jpeg" ? "jpg" : cleaned;
  }
  const streamType =
    decryptMediaAs ||
    (type === "sticker" ? "sticker" : type);
  const filePath = join(basePath, `${id}.${ext}`);
  const stream = await downloadContentFromMessage(content, streamType);
  const buffer = await streamToBuffer(stream);
  writeFileSync(filePath, buffer);
  return filePath;
}
