/**
 * Fila dos comandos de mídia. Roda até `perChat` comandos ao mesmo tempo no mesmo chat e
 * `global` no bot todo (ffmpeg/sharp pesam: a VPS tem 2 núcleos). O resto espera a vez na ordem
 * em que chegou. Cada comando leva o próprio contexto (mensagem a responder), então rodar junto
 * não mistura os replies.
 */
export class ChatCommandQueue {
  constructor({ perChat = 2, global = 2 } = {}) {
    this.perChat = Math.max(1, perChat);
    this.global = Math.max(1, global);
    this.running = 0;
    this.runningByChat = new Map();
    this.waiting = [];
  }

  enqueue(chatId, task) {
    const key = String(chatId ?? "unknown");
    return new Promise((resolve, reject) => {
      this.waiting.push({ key, task, resolve, reject });
      this._pump();
    });
  }

  /** Quantos comandos estão esperando ou rodando nesse chat. */
  pending(chatId) {
    const key = String(chatId ?? "unknown");
    return (this.runningByChat.get(key) ?? 0) + this.waiting.filter((w) => w.key === key).length;
  }

  _pump() {
    for (let i = 0; i < this.waiting.length && this.running < this.global; ) {
      const job = this.waiting[i];
      if ((this.runningByChat.get(job.key) ?? 0) >= this.perChat) {
        i += 1;
        continue;
      }
      this.waiting.splice(i, 1);
      this._start(job);
    }
  }

  _start({ key, task, resolve, reject }) {
    this.running += 1;
    this.runningByChat.set(key, (this.runningByChat.get(key) ?? 0) + 1);
    Promise.resolve()
      .then(() => task())
      .then(resolve, reject)
      .finally(() => {
        this.running -= 1;
        const n = (this.runningByChat.get(key) ?? 1) - 1;
        if (n > 0) this.runningByChat.set(key, n);
        else this.runningByChat.delete(key);
        this._pump();
      });
  }
}
