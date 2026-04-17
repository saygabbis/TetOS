import { DEFAULTS } from "../../infra/config/defaults.js";

export function planStickerOnly({ policy, isGroup = false, hasMedia = false } = {}) {
  if (!isGroup) return { useSticker: false };
  if (hasMedia) return { useSticker: false };
  if (policy?.mode === "react_only" && Math.random() < DEFAULTS.stickerOnlyChance) {
    return { useSticker: true, stickerKey: "ack" };
  }
  return { useSticker: false };
}
