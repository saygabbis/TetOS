/** Meta leve para shortTerm — evita recentHistory/brain aninhados (explodem o prompt). */
export function slimMetaForStorage(meta = {}) {
  if (!meta || typeof meta !== "object") return {};
  const out = {};
  const uid = meta.userId ?? meta.participantId;
  if (uid) out.userId = String(uid).slice(0, 80);
  if (meta.sessionId) out.sessionId = String(meta.sessionId).slice(0, 120);
  if (meta.channelId) out.channelId = String(meta.channelId).slice(0, 120);
  if (meta.isGroup) out.isGroup = true;
  if (meta.speakerName) out.speakerName = String(meta.speakerName).slice(0, 80);
  if (meta.isReplyToBot) out.isReplyToBot = true;
  if (meta.quotedMessageId) out.quotedMessageId = String(meta.quotedMessageId).slice(0, 80);
  if (meta.messageId) out.messageId = String(meta.messageId).slice(0, 80);
  const q = meta.quotedMessage ?? meta.replyThreadContext?.quoted?.text;
  if (q) out.quotedMessage = String(q).slice(0, 400);
  return out;
}

export function repairShortTermMessage(msg = {}) {
  const content = String(msg?.content ?? "").slice(0, 4000);
  if (!content && msg?.role !== "system") return null;
  return {
    role: msg?.role === "assistant" ? "assistant" : msg?.role === "system" ? "system" : "user",
    content,
    ...(msg?.meta ? { meta: slimMetaForStorage(msg.meta) } : {})
  };
}
