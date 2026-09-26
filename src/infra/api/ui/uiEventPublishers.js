/**
 * Helpers de eventos SSE alinhados ao desktop (extensões além do agent-protocol base).
 */

export function publishUiNotification(uiBus, { kind, title, body, action = null, level = "info" }) {
  const notification = {
    id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: String(title ?? ""),
    body: String(body ?? ""),
    createdAt: new Date().toISOString(),
    level,
    kind: kind ?? "care",
    ...(action ? { action } : {}),
  };
  uiBus.publish({ type: "notification", notification });
  return notification;
}

export function publishChannelStatus(uiBus, { channelId = "whatsapp", status, qrDataUrl = null }) {
  uiBus.publish({
    type: "channel.status",
    channelId,
    status,
    ...(qrDataUrl ? { qrDataUrl } : {}),
    at: new Date().toISOString(),
  });
}

export function publishAssistantTyping(uiBus, threadId, active) {
  uiBus.publish({
    type: "assistant.typing",
    threadId,
    isTyping: Boolean(active),
  });
}
