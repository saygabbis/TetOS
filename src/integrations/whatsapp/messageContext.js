/** Extrai contextInfo (quote, menções) de qualquer tipo de mensagem WA. */
export function extractContextInfo(unwrappedMessage = {}) {
  const sources = [
    unwrappedMessage?.extendedTextMessage,
    unwrappedMessage?.imageMessage,
    unwrappedMessage?.videoMessage,
    unwrappedMessage?.audioMessage,
    unwrappedMessage?.documentMessage,
    unwrappedMessage?.stickerMessage,
    unwrappedMessage?.buttonsResponseMessage,
    unwrappedMessage?.listResponseMessage
  ];
  for (const src of sources) {
    if (src?.contextInfo) return src.contextInfo;
  }
  return {};
}

/** Detecta menção direta à Teto em grupo (evita falso positivo em palavras aleatórias). */
export function isDirectTetoAddress(text = "", { hasMention = false, isReplyToBot = false } = {}) {
  if (hasMention || isReplyToBot) return true;
  const t = String(text ?? "").trim();
  if (!t) return false;
  return (
    /^(oi+e?|oie+|eae+|hey+|e\s*a[ií])\s+(teto|tetozinha)\b/i.test(t) ||
    /\b(teto|tetozinha)[!?,.\s]*$/i.test(t) ||
    /\b(minha\s+)?tetozinha\b/i.test(t) ||
    /\be\s+a[ií]\s+teto\b/i.test(t)
  );
}
