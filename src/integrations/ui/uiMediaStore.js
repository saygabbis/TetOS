import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, join, resolve } from "node:path";

/** Mídia da interface desktop: anexos enviados pelo usuário e saídas da Teto (figurinhas, downloads...). */

const MEDIA_ID_RE = /^[a-z0-9]+-[a-f0-9]{8}\.[a-z0-9]{2,5}$/;

const MIME_BY_EXT = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  txt: "text/plain"
});

const EXT_BY_MIME = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "application/pdf": "pdf",
  "text/plain": "txt"
});

export function getUiMediaDir(defaults = {}) {
  return process.env.TETOS_UI_MEDIA_PATH ?? join(defaults.whatsappMediaPath ?? "./data/media", "ui");
}

export function extFromMime(mimeType, fileName = "") {
  const mime = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const fromName = extname(String(fileName ?? "")).replace(".", "").toLowerCase();
  if (fromName && MIME_BY_EXT[fromName]) return fromName === "jpeg" ? "jpg" : fromName;
  return "bin";
}

export function mimeFromExt(ext) {
  return MIME_BY_EXT[String(ext ?? "").toLowerCase().replace(/^\./, "")] ?? "application/octet-stream";
}

/** Tipo de mídia no vocabulário do MediaProcessor (image | video | gif | audio | sticker | document). */
export function inputTypeFromMime(mimeType) {
  const mime = String(mimeType ?? "").toLowerCase();
  if (mime === "image/webp") return "sticker";
  if (mime === "image/gif") return "gif";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/** Tipo exibido na UI (MediaRef.kind). */
export function uiKindFromMime(mimeType, { sticker = false } = {}) {
  const mime = String(mimeType ?? "").toLowerCase();
  if (sticker || mime === "image/webp") return "sticker";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;[^,]*)?,([\s\S]*)$/.exec(String(dataUrl ?? ""));
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const isBase64 = /;base64/i.test(match[2] ?? "");
  try {
    const buffer = isBase64
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "utf8");
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

export function isValidUiMediaId(id) {
  return MEDIA_ID_RE.test(String(id ?? ""));
}

export function resolveUiMediaPath(dir, id) {
  if (!isValidUiMediaId(id)) return null;
  const root = resolve(dir);
  const full = resolve(root, id);
  if (!full.startsWith(root)) return null;
  return existsSync(full) ? full : null;
}

export function saveUiMediaBuffer(buffer, { dir, mimeType, fileName = null, sticker = false, animated = false } = {}) {
  if (!buffer?.length) throw new Error("arquivo vazio");
  mkdirSync(dir, { recursive: true });
  const ext = extFromMime(mimeType, fileName ?? "");
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${ext}`;
  const path = join(dir, id);
  writeFileSync(path, buffer);
  const resolvedMime = mimeType && mimeType !== "application/octet-stream" ? mimeType : mimeFromExt(ext);
  return { id, path, mimeType: resolvedMime, fileName, sticker, animated, size: buffer.length };
}

export function saveUiMediaFile(sourcePath, opts = {}) {
  const buffer = readFileSync(sourcePath);
  const ext = extname(sourcePath).replace(".", "");
  const mimeType = opts.mimeType ?? mimeFromExt(ext);
  return saveUiMediaBuffer(buffer, { ...opts, mimeType, fileName: opts.fileName ?? sourcePath });
}

/** Referência enviada à UI (MediaRef do agent-protocol). */
export function toMediaRef(entry) {
  const kind = uiKindFromMime(entry.mimeType, { sticker: entry.sticker });
  return {
    kind,
    mimeType: entry.mimeType,
    name: entry.fileName ? String(entry.fileName).split(/[\\/]/).pop() : entry.id,
    url: `/ui/media/${entry.id}`,
    mediaId: entry.id,
    ...(entry.animated ? { animated: true } : {})
  };
}

/** Converte um anexo recebido no POST /ui/threads/:id/messages (dataUrl/base64/mediaId/url) em MediaRef persistido. */
export function ingestAttachment(item, { dir }) {
  if (!item || typeof item !== "object") return null;

  const mediaId = typeof item.mediaId === "string" ? item.mediaId : item.url?.match?.(/\/ui\/media\/([^/?#]+)/)?.[1];
  if (mediaId && resolveUiMediaPath(dir, mediaId)) {
    const ext = mediaId.split(".").pop();
    const mimeType = item.mimeType ?? mimeFromExt(ext);
    return {
      kind: item.kind && item.kind !== "image" ? item.kind : uiKindFromMime(mimeType),
      mimeType,
      name: item.name ?? mediaId,
      url: `/ui/media/${mediaId}`,
      mediaId,
      ...(item.animated ? { animated: true } : {})
    };
  }

  const dataUrl =
    typeof item.dataUrl === "string"
      ? item.dataUrl
      : typeof item.base64 === "string"
        ? item.base64.startsWith("data:")
          ? item.base64
          : `data:${item.mimeType ?? "image/png"};base64,${item.base64}`
        : typeof item.url === "string" && item.url.startsWith("data:")
          ? item.url
          : null;
  if (!dataUrl) return null;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed?.buffer?.length) return null;
  const saved = saveUiMediaBuffer(parsed.buffer, {
    dir,
    mimeType: item.mimeType ?? parsed.mimeType,
    fileName: item.name ?? null
  });
  return toMediaRef(saved);
}

/** Entrada do MediaProcessor a partir de um MediaRef salvo. */
export function mediaInputFromRef(ref, { dir }) {
  const path = resolveUiMediaPath(dir, ref?.mediaId);
  if (!path) return null;
  const mimeType = ref.mimeType ?? mimeFromExt(extname(path));
  const type = inputTypeFromMime(mimeType);
  return {
    path,
    type,
    mimetype: mimeType,
    ...(ref.animated ? { isAnimated: true } : {}),
    mediaId: ref.mediaId
  };
}

/**
 * Resolve a mídia citada (message id da UI) dentro de uma thread.
 * Aceita: `latest`/vazio (última mídia), `<messageId>`, `<messageId>#<n>` ou o próprio `mediaId`.
 */
export function resolveThreadMediaRef(thread, ref = null, { skipMessageId = null } = {}) {
  const messages = thread?.messages ?? [];
  const wanted = String(ref ?? "").trim();
  const collect = (m) => (m.attachments ?? []).filter((a) => a?.mediaId);

  if (wanted && wanted !== "latest") {
    const [rawId, rawIdx] = wanted.split("#");
    const idx = rawIdx !== undefined ? Number.parseInt(rawIdx, 10) : 0;
    const byMessage = messages.find((m) => m.id === rawId);
    if (byMessage) {
      const list = collect(byMessage);
      if (list[Number.isFinite(idx) ? idx : 0]) return list[Number.isFinite(idx) ? idx : 0];
    }
    for (const m of messages) {
      const hit = collect(m).find((a) => a.mediaId === wanted);
      if (hit) return hit;
    }
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (skipMessageId && m.id === skipMessageId) continue;
    const list = collect(m);
    if (list.length) return list[list.length - 1];
  }
  return null;
}
