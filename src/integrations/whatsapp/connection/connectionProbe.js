import { S_WHATSAPP_NET } from "baileys";

/**
 * Sonda ativa da conexão: a cada `intervalMs` manda um ping (iq w:p) e espera resposta.
 * Cobre o caso em que o WebSocket morre sem emitir "close" — o keepalive do Baileys só avisa
 * e nunca reconecta, e a Teto ficava "desligada" até alguém reiniciar o processo.
 */
export function startConnectionProbe({
  label = "whatsapp",
  getSocket,
  getConnected,
  onDead,
  intervalMs = Number(process.env.WHATSAPP_PROBE_INTERVAL_MS ?? 4 * 60 * 1000),
  timeoutMs = 25_000,
  maxFailures = 2
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  let failures = 0;
  let recovering = false;

  const probe = async () => {
    if (recovering || !getConnected?.()) return;
    const socket = getSocket?.();
    if (!socket) return;
    try {
      if (socket.ws && socket.ws.isOpen === false) throw new Error("websocket fechado sem evento de close");
      await Promise.race([
        socket.query({ tag: "iq", attrs: { to: S_WHATSAPP_NET, type: "get", xmlns: "w:p" }, content: [{ tag: "ping", attrs: {} }] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("ping sem resposta")), timeoutMs))
      ]);
      failures = 0;
    } catch (error) {
      failures += 1;
      console.warn(`[${label}] sonda de conexão falhou (${failures}/${maxFailures}): ${error?.message ?? error}`);
      if (failures < maxFailures) return;
      failures = 0;
      recovering = true;
      try {
        console.warn(`[${label}] conexão parece morta — reconectando`);
        await onDead?.();
      } catch (err) {
        console.error(`[${label}] falha ao reconectar após sonda:`, err?.message ?? err);
      } finally {
        recovering = false;
      }
    }
  };

  const timer = setInterval(() => void probe(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
