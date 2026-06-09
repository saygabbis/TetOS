function escapeRegExp(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Converte @número ou @Nome em menção real do Baileys.
 * @param {string} text
 * @param {Array<{ userId, displayName, mentionJid }>} members
 */
export function applyWhatsAppMentions(text, members = []) {
  let out = String(text ?? "");
  if (!out || !members.length) return { text: out, mentions: [] };

  const mentions = [];
  const seen = new Set();

  const pushMention = (jid) => {
    if (!jid || seen.has(jid)) return;
    mentions.push(jid);
    seen.add(jid);
  };

  for (const m of members) {
    if (!m?.userId || !m?.mentionJid) continue;
    const id = String(m.userId);
    const phoneRe = new RegExp(`@${escapeRegExp(id)}(?!\\d)`, "g");
    if (phoneRe.test(out)) {
      out = out.replace(phoneRe, `@${m.displayName}`);
      pushMention(m.mentionJid);
    }
  }

  for (const m of members) {
    if (!m?.displayName || !m?.mentionJid) continue;
    const nameRe = new RegExp(`@${escapeRegExp(m.displayName)}`, "gi");
    if (nameRe.test(out)) {
      pushMention(m.mentionJid);
    }
  }

  return { text: out, mentions };
}
