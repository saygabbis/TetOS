/**
 * Onde a atenção da Teto está agora: ela é uma só, com um celular só. Se está no meio de um papo no
 * Discord e chega mensagem no zap, ela sai de lá e vai pro zap (e vice-versa) — trocar de app leva
 * uns segundos, e o papo antigo fica pra quando ela voltar.
 *
 * "Conversando" = respondeu alguém nos últimos `holdMs`.
 */

const PLATFORM_LABEL = { whatsapp: "WhatsApp", discord: "Discord", app: "app TetOS" };

export const platformLabel = (platform) => PLATFORM_LABEL[platform] ?? platform;

export class AttentionFocus {
  constructor({ holdMs = 3 * 60_000, now = () => Date.now(), random = Math.random } = {}) {
    this.holdMs = holdMs;
    this.now = now;
    this.random = random;
    this.last = null;
    this.previous = null;
  }

  /** Ela respondeu (ou abriu) uma conversa nesse app. `place` = texto curto pro prompt ("#geral do servidor X"). */
  note(platform, chatId, place = null) {
    const at = this.now();
    if (this.last && this.last.platform !== platform) this.previous = { ...this.last, leftAt: at };
    this.last = { platform, chatId: String(chatId ?? ""), place, at };
  }

  /** Conversa ativa agora (ou null). */
  active() {
    if (!this.last || this.now() - this.last.at > this.holdMs) return null;
    return this.last;
  }

  /**
   * Quanto demora pra ela ver uma mensagem que chegou em outro app enquanto conversa num.
   * Mesmo app (outro chat) não custa nada: já está com ele aberto.
   */
  switchDelayMs(platform, { isOwner = false } = {}) {
    const cur = this.active();
    if (!cur || cur.platform === platform) return 0;
    const [lo, hi] = isOwner ? [8, 25] : [15, 45];
    return Math.round((lo + this.random() * (hi - lo)) * 1000);
  }

  /** Linha pro prompt quando ela acabou de chegar de outro app. */
  promptLine(platform) {
    const from = this.last && this.last.platform !== platform ? this.last : this.previous?.platform !== platform ? this.previous : null;
    if (!from) return null;
    const ago = this.now() - (from.leftAt ?? from.at);
    if (ago > 10 * 60_000) return null;
    const mins = Math.max(1, Math.round(ago / 60_000));
    const where = from.place ? ` (${from.place})` : "";
    return `Você estava conversando no ${platformLabel(from.platform)}${where} até ~${mins} min atrás e veio pra cá. Pode comentar de leve se encaixar ("tava no ${platformLabel(from.platform).toLowerCase()}"), sem contar o que falaram lá.`;
  }
}
