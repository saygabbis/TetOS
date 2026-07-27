function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parseia `.tetos <mensagem>` (também aceita `/tetos`).
 * @returns {{ prompt: string } | null}
 */
export function parseTetosCommand(text = "", prefix = ".") {
  const raw = String(text ?? "").trim();
  const p = escapeRegExp(prefix || ".");
  const pattern = new RegExp(`^(?:\\/|${p})tetos(?:\\s+([\\s\\S]*))?$`, "i");
  const match = raw.match(pattern);
  if (!match) return null;
  return { prompt: String(match[1] ?? "").trim() };
}

/**
 * Remove menções à Teto/bot do texto do comando (não faz parte da pergunta).
 */
export function stripTetosPromptMentions(prompt = "", { botPhone, mentionHint = [] } = {}) {
  let t = String(prompt ?? "").trim();
  const phoneDigits = String(botPhone ?? "").replace(/\D/g, "");

  if (phoneDigits) {
    t = t.replace(new RegExp(`@${phoneDigits}\\b`, "gi"), " ").trim();
  }

  t = t.replace(/@\d{4,}\b/g, " ").trim();

  for (const raw of mentionHint) {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (digits.length >= 4) {
      t = t.replace(new RegExp(`@${digits}\\b`, "gi"), " ").trim();
    }
  }

  t = t.replace(/^(teto|tetozinha)[,!?.\s]+/i, "").trim();
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

export function formatTetosUsage(prefix = ".") {
  const p = prefix || ".";
  return `uso: ${p}tetos <mensagem> — pergunta pontual à IA (sem conversa contínua)`;
}

/** Resolve o texto que entra no pipeline a partir do comando `.tetos`. */
export function resolveTetosMessage(tetosCmd, { botPhone, mentionHint = [] } = {}) {
  if (!tetosCmd) return "";
  return stripTetosPromptMentions(tetosCmd.prompt, { botPhone, mentionHint });
}

/** Reply na resposta de um `.tetos` — não deve abrir janela nem gerar conversa. */
export function isQuotedTetosOneShot(messageIndex, channelId, messageId) {
  if (!messageIndex || !channelId || !messageId) return false;
  const row = messageIndex.get(channelId, messageId);
  return Boolean(row?.tetosOneShot);
}
