let lastInboundAt = Date.now();
let lastBotInboundAt = Date.now();

export function touchInboundActivity(_source = "any") {
  const now = Date.now();
  lastInboundAt = now;
  // Qualquer sessão Baileys (main/media/full) conta — evita reconnect falso em mode=dual.
  lastBotInboundAt = now;
}

export function resetInboundActivity() {
  const now = Date.now();
  lastInboundAt = now;
  lastBotInboundAt = now;
}

export function msSinceLastInbound({ botOnly = false } = {}) {
  return Date.now() - (botOnly ? lastBotInboundAt : lastInboundAt);
}
