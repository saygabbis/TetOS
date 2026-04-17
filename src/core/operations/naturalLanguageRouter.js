export function detectNaturalAdminIntent(text, channelId = null) {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  if (/\b(fica\s+quieta|fica\s+quieto|pare\s+de\s+responder|para\s+de\s+responder|silencia\s+esse\s+chat|não\s+responde\s+mais|nao\s+responde\s+mais)\b/i.test(lower)) {
    return { type: "channel_admin", payload: { channelId: channelId ?? "current", action: "mute" } };
  }
  if (/\b(pode\s+voltar|volta\s+a\s+responder|pode\s+responder\s+de\s+novo|desmute|reativa\s+esse\s+chat)\b/i.test(lower)) {
    return { type: "channel_admin", payload: { channelId: channelId ?? "current", action: "unmute" } };
  }

  const channelRef = lower.match(/\b(canal|grupo)\s+([^\s]+)/i)?.[2]?.trim() ?? null;
  if (!channelRef) return null;

  if (/\b(pode\s+mutar|mute|silencia|silenciar)\b/i.test(lower)) {
    return { type: "channel_admin", payload: { channelId: channelRef, action: "mute" } };
  }
  if (/\b(pode\s+desmutar|desmute|reativa|reativar)\b/i.test(lower)) {
    return { type: "channel_admin", payload: { channelId: channelRef, action: "unmute" } };
  }
  if (/\b(pode\s+bloquear|bloqueia|bloquear)\b/i.test(lower)) {
    return { type: "channel_admin", payload: { channelId: channelRef, action: "block" } };
  }
  if (/\b(pode\s+autorizar|autoriza|libera|liberar)\b/i.test(lower)) {
    return { type: "channel_admin", payload: { channelId: channelRef, action: "authorize" } };
  }
  const modeMatch = lower.match(/\bmodo\s+(active|passive|blocked)\b/i);
  if (modeMatch) {
    return {
      type: "channel_admin",
      payload: {
        channelId: channelRef,
        action: "set_mode",
        mode: modeMatch[1].toLowerCase()
      }
    };
  }

  return null;
}
