import { jidNormalizedUser } from "baileys";

/** "composing" chega de tempos em tempos enquanto a pessoa digita; sem novo sinal, assume que parou. */
const DEFAULT_GRACE_MS = 7000;
/** Áudio sendo gravado ("recording") demora mais que texto. */
const RECORDING_GRACE_MS = 15000;

const norm = (jid) => (jid ? jidNormalizedUser(String(jid)) : "");

/**
 * Estado de digitação por chat (PV) ou por participante (grupo), alimentado por presence.update
 * — que só chega depois de `presenceSubscribe(chat)`.
 */
export class TypingTracker {
  constructor({ graceMs = DEFAULT_GRACE_MS, now = () => Date.now() } = {}) {
    this.graceMs = graceMs;
    this.now = now;
    this.byKey = new Map();
  }

  static key(chatJid, participantJid = null) {
    const chat = norm(chatJid);
    const part = norm(participantJid);
    return part && part !== chat ? `${chat}|${part}` : chat;
  }

  /** presence: composing | recording | paused | available | unavailable */
  set(chatJid, participantJid, presence) {
    const key = TypingTracker.key(chatJid, participantJid);
    if (!key) return;
    const now = this.now();
    if (presence === "composing" || presence === "recording") {
      const grace = presence === "recording" ? RECORDING_GRACE_MS : this.graceMs;
      this.byKey.set(key, { until: now + grace, stoppedAt: null });
    } else {
      this.byKey.set(key, { until: 0, stoppedAt: now });
    }
  }

  /** Alguém está digitando nesse chat? Com participante, olha só ele. */
  isTyping(chatJid, participantJid = null) {
    const now = this.now();
    if (participantJid) {
      return (this.byKey.get(TypingTracker.key(chatJid, participantJid))?.until ?? 0) > now;
    }
    const chat = norm(chatJid);
    for (const [key, row] of this.byKey) {
      if ((key === chat || key.startsWith(`${chat}|`)) && row.until > now) return true;
    }
    return false;
  }

  /** A mensagem chegou: quem mandou parou de digitar (ela pode recomeçar a seguir). */
  clear(chatJid, participantJid = null) {
    this.byKey.set(TypingTracker.key(chatJid, participantJid), { until: 0, stoppedAt: this.now() });
  }
}
