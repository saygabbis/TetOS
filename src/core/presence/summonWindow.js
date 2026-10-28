/**
 * Chamada direta: `.tetos` no PV do zap ou marcar ela (@) no Discord faz ela vir na hora, mesmo ocupada.
 * Depois disso ela fica "com a conversa aberta" por uns segundos: as mensagens seguintes dessa pessoa
 * nesse chat também são respondidas na hora, e cada uma renova a janela.
 */
export class SummonWindow {
  constructor({ ms = 30_000, now = () => Date.now() } = {}) {
    this.ms = ms;
    this.now = now;
    this.until = new Map();
  }

  /** Chamou: abre (ou renova) a janela. */
  summon(key) {
    if (!key) return;
    this.until.set(String(key), this.now() + this.ms);
    if (this.until.size > 500) {
      const now = this.now();
      for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
    }
  }

  isActive(key) {
    const t = this.until.get(String(key ?? ""));
    return Boolean(t && t > this.now());
  }

  /** Mensagem dentro da janela: conta como chamada e renova. */
  touch(key) {
    if (!this.isActive(key)) return false;
    this.summon(key);
    return true;
  }
}
