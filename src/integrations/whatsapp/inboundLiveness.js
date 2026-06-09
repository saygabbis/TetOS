let lastInboundAt = Date.now();

export function touchInboundActivity() {
  lastInboundAt = Date.now();
}

export function resetInboundActivity() {
  lastInboundAt = Date.now();
}

export function msSinceLastInbound() {
  return Date.now() - lastInboundAt;
}
