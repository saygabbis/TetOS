/**
 * Helpers de eventos SSE alinhados ao desktop (extensões além do agent-protocol base).
 */

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
