import { readFileSync } from "node:fs";
import { extname } from "node:path";
import sharp from "sharp";
import { isAnimatedImage } from "./backgroundRemovalService.js";

function isGifLikeFile(inputPath) {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".gif") return true;
  try {
    const head = readFileSync(inputPath, { start: 0, end: 5 });
    const s = head.toString("ascii");
    return s.startsWith("GIF87a") || s.startsWith("GIF89a");
  } catch {
    return false;
  }
}

/**
 * Figurinha animada vs estática (WebP/GIF). Usa metadado WA, ficheiro e Sharp.
 */
export async function probeStickerIsAnimated(filePath, { isAnimatedHint = false } = {}) {
  if (isAnimatedHint === true || isAnimatedHint === "true") return true;
  if (!filePath) return false;
  if (isGifLikeFile(filePath)) return true;
  if (await isAnimatedImage(filePath)) return true;
  try {
    const meta = await sharp(filePath, { animated: true }).metadata();
    if (Number(meta?.pages ?? 1) > 1) return true;
  } catch {
    /* static ou formato desconhecido */
  }
  return false;
}
