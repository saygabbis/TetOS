import { extname } from "node:path";
import sharp from "sharp";
import { readFileHead } from "./fileHead.js";

function isGifLikeFile(inputPath) {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".gif") return true;
  const s = readFileHead(inputPath, 6).toString("ascii");
  return s.startsWith("GIF87") || s.startsWith("GIF89");
}

/** JPEG/PNG reais pelo magic byte — WA às vezes manda WebP animado com extensão .jpg. */
export function isLikelyStaticRaster(inputPath) {
  const head = readFileHead(inputPath, 16);
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  if (head.length >= 8 && head[0] === 0x89 && head.toString("ascii", 1, 4) === "PNG") return true;
  return false;
}

function webpHeadLooksAnimated(head) {
  if (
    head.length < 12 ||
    head.toString("ascii", 0, 4) !== "RIFF" ||
    head.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return false;
  }
  return head.includes(Buffer.from("ANIM"));
}

/**
 * Figurinha animada vs estática (WebP/GIF). Usa metadado WA, ficheiro e Sharp.
 */
export async function probeStickerIsAnimated(filePath, { isAnimatedHint = false } = {}) {
  if (isAnimatedHint === true || isAnimatedHint === "true") return true;
  if (!filePath) return false;
  if (isLikelyStaticRaster(filePath)) return false;
  if (isGifLikeFile(filePath)) return true;
  const head = readFileHead(filePath, 262144);
  if (webpHeadLooksAnimated(head)) return true;
  try {
    const meta = await sharp(filePath, { animated: true }).metadata();
    if (Number(meta?.pages ?? 1) > 1) return true;
  } catch {
    /* static ou formato desconhecido */
  }
  return false;
}
