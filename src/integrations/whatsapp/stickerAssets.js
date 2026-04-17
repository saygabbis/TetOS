import { existsSync } from "node:fs";
import { join } from "node:path";

const FALLBACK_KEYS = ["ack", "ok", "thumbs_up", "heart"];

export function resolveStickerAsset(stickerKey, basePath = "./data/stickers") {
  const candidates = [stickerKey, ...FALLBACK_KEYS].filter(Boolean);
  for (const key of candidates) {
    const filePath = join(basePath, `${key}.webp`);
    if (existsSync(filePath)) {
      return { url: filePath, key };
    }
  }
  return null;
}
