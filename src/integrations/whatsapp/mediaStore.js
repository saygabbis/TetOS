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

export async function persistMedia({ downloadContentFromMessage, content, type, id, basePath = "./data/media" }) {
  if (!content || !id) return null;
  ensureDir(basePath);
  const ext = type === "image"
    ? "jpg"
    : type === "video"
      ? "mp4"
      : type === "audio"
        ? "ogg"
        : type === "sticker"
          ? "webp"
          : "bin";
  const streamType = type === "sticker" ? "sticker" : type;
  const filePath = join(basePath, `${id}.${ext}`);
  const stream = await downloadContentFromMessage(content, streamType);
  const buffer = await streamToBuffer(stream);
  writeFileSync(filePath, buffer);
  return filePath;
}
