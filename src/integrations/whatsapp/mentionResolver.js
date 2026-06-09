function escapeRegExp(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function memberLookup(members = []) {
  const byKey = new Map();
  for (const m of members) {
    if (!m?.userId) continue;
    const keys = new Set([
      String(m.userId),
      m.waPhone,
      m.waLid,
      m.canonicalUserId
    ].filter(Boolean));
    for (const k of keys) {
      byKey.set(k, m);
      if (k.startsWith("dm-")) byKey.set(k.slice(3), m);
    }
  }
  return byKey;
}

/**
 * Converte @número, @LID ou @Nome em menção real do Baileys.
 * @param {string} text
 * @param {Array<{ userId, displayName, mentionJid, waPhone?, waLid? }>} members
 */
export function applyWhatsAppMentions(text, members = []) {
  let out = String(text ?? "");
  if (!out || !members.length) return { text: out, mentions: [] };

  const lookup = memberLookup(members);
  const mentions = [];
  const seen = new Set();

  const pushMention = (jid) => {
    if (!jid || seen.has(jid)) return;
    mentions.push(jid);
    seen.add(jid);
  };

  const resolveMember = (rawId) => {
    const id = String(rawId ?? "").trim();
    return (
      lookup.get(id) ??
      lookup.get(`dm-${id}`) ??
      null
    );
  };

    for (const m of members) {
    if (!m?.userId || !m?.mentionJid) continue;
    const id = String(m.userId);
    const phoneRe = new RegExp(`@${escapeRegExp(id)}(?!\\d)`, "g");
    if (phoneRe.test(out)) {
      out = out.replace(phoneRe, `@${m.displayName}`);
      pushMention(m.mentionJid);
    }
    if (m.waLid) {
      const lidRe = new RegExp(`@${escapeRegExp(m.waLid)}(?!\\d)`, "g");
      if (lidRe.test(out)) {
        out = out.replace(lidRe, `@${m.displayName}`);
        pushMention(m.mentionJid);
      }
    }
    if (m.waPhone && m.waPhone !== id) {
      const telRe = new RegExp(`@${escapeRegExp(m.waPhone)}(?!\\d)`, "g");
      if (telRe.test(out)) {
        out = out.replace(telRe, `@${m.displayName}`);
        pushMention(m.mentionJid);
      }
    }
    for (const nick of [...(m.nicknames ?? []), ...(m.tetoNicknames ?? [])]) {
      if (!nick || nick === m.displayName) continue;
      const nickRe = new RegExp(`@${escapeRegExp(nick)}(?!\\w)`, "gi");
      if (nickRe.test(out)) {
        pushMention(m.mentionJid);
      }
    }
  }

  out = out.replace(/@(\d{8,})(?!\d)/g, (full, digits) => {
    const m = resolveMember(digits);
    if (!m?.displayName) return full;
    pushMention(m.mentionJid);
    return `@${m.displayName}`;
  });

  for (const m of members) {
    if (!m?.displayName || !m?.mentionJid) continue;
    const nameRe = new RegExp(`@${escapeRegExp(m.displayName)}`, "gi");
    if (nameRe.test(out)) {
      pushMention(m.mentionJid);
    }
  }

  return { text: out, mentions };
}
