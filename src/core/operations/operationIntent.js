export function detectOperationIntent(text, channelId = null) {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  if (/\b(fica\s+quieta|fica\s+quieto|pare\s+de\s+responder|para\s+de\s+responder|silencia\s+esse\s+chat|não\s+responde\s+mais|nao\s+responde\s+mais)\b/i.test(lower)) {
    return {
      type: "channel_admin",
      payload: {
        channelId: channelId ?? "current",
        action: "mute"
      }
    };
  }
  if (/\b(pode\s+voltar|volta\s+a\s+responder|pode\s+responder\s+de\s+novo|desmute|reativa\s+esse\s+chat)\b/i.test(lower)) {
    return {
      type: "channel_admin",
      payload: {
        channelId: channelId ?? "current",
        action: "unmute"
      }
    };
  }

  const modeMatch = lower.match(/\b(mutar|desmutar|autorizar|bloquear)\b\s+canal\s+([^\s]+)(?:\s+modo\s+(active|passive|blocked))?/i);
  if (modeMatch) {
    const actionWord = modeMatch[1].toLowerCase();
    const actionMap = {
      mutar: "mute",
      desmutar: "unmute",
      autorizar: "authorize",
      bloquear: "block"
    };
    return {
      type: "channel_admin",
      payload: {
        channelId: modeMatch[2].trim(),
        action: actionMap[actionWord] ?? actionWord,
        mode: modeMatch[3] ?? undefined
      }
    };
  }

  const setModeMatch = lower.match(/\bmodo\s+do\s+canal\s+([^\s]+)\s+(active|passive|blocked)\b/i);
  if (setModeMatch) {
    return {
      type: "channel_admin",
      payload: {
        channelId: setModeMatch[1].trim(),
        action: "set_mode",
        mode: setModeMatch[2]
      }
    };
  }

  return null;
}
