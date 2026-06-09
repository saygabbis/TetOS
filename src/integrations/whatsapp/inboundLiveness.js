let lastInboundAt = Date.now();
let lastBotInboundAt = Date.now();

export function touchInboundActivity(source = "any") {
  lastInboundAt = Date.now();
  if (source === "bot" || source === "full") {
    lastBotInboundAt = Date.now();
  }
}

export function resetInboundActivity() {
  const now = Date.now();
  lastInboundAt = now;
  lastBotInboundAt = now;
}

export function msSinceLastInbound({ botOnly = false } = {}) {
  return Date.now() - (botOnly ? lastBotInboundAt : lastInboundAt);
}
