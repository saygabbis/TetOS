import { DEFAULTS } from "../../infra/config/defaults.js";
import { HABITS, temperament } from "../mind/temperament.js";
import { RESPONSE_MODES } from "../pipeline/responseModes.js";

export function resolvePassiveModeAction({ policy, media = null } = {}) {
  if (!policy?.allowed) {
    return { type: "ignore" };
  }

  if (policy.mode === RESPONSE_MODES.REACT_ONLY) {
    if (!media && Math.random() < temperament.chance("sticker_ack", DEFAULTS.stickerOnlyChance, HABITS.sticker_only)) {
      return { type: RESPONSE_MODES.STICKER_ONLY, stickerKey: "ack" };
    }
    return { type: RESPONSE_MODES.REACT_ONLY };
  }

  return { type: RESPONSE_MODES.FULL };
}
