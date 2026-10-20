/**
 * "Online" de verdade: ela aparece online enquanto está usando o zap (respondendo ou acabou de ler)
 * e some uns minutos depois — o resto do tempo fica o "visto por último". Dormindo/na rua: offline.
 */
export function createPresenceManager({ getSocket, idleMs = 150_000 } = {}) {
  let current = null;
  let timer = null;
  const set = async (presence) => {
    if (current === presence) return;
    current = presence;
    try {
      await getSocket()?.sendPresenceUpdate?.(presence);
    } catch {
      current = null;
    }
  };
  return {
    /** Abriu o app / está conversando: online por mais `idleMs`. */
    active() {
      void set("available");
      clearTimeout(timer);
      timer = setTimeout(() => void set("unavailable"), idleMs);
      timer.unref?.();
    },
    offline() {
      clearTimeout(timer);
      void set("unavailable");
    },
    /** Socket novo (reconexão): o servidor não sabe o estado — reenvia na próxima mudança. */
    reset() {
      current = null;
    }
  };
}
