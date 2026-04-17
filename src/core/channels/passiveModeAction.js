import { DEFAULTS } from "../../infra/config/defaults.js";

export function resolvePassiveModeAction({ policy, media = null } = {}) {
  if (!policy?.allowed) {
    return { type: "ignore" };
  }

  if (policy.mode === "react_only") {
    if (!media && Math.random() < DEFAULTS.stickerOnlyChance) {
      return { type: "sticker_only", stickerKey: "ack" };
    }
    return { type: "react_only" };
  }

  return { type: "full" };
}
