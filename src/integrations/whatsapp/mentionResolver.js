import { cleanDisplayName, extractLocalPart } from "../../core/channels/waIdentity.js";

function escapeRegExp(s = "") {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Chave de lookup: minúsculas, sem acento — @Gabbis e @gabbis viram a mesma chave. */
export function normalizeMentionToken(raw = "") {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
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

/** Handle de menção — mantém dígitos (Kzer0) mas limpa emoji/sufixo decorativo. */
function mentionHandle(raw = "") {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const m = s.match(/^([\p{L}\p{N}][\p{L}\p{N}_-]{0,31})/u);
  if (m) return m[1];
  return cleanDisplayName(s);
}

/** Rótulos @ aceitos (nome, apelidos, primeiro nome). */
export function collectMentionableLabels(member = {}) {
  const labels = new Set();
  const add = (raw) => {
    const handle = mentionHandle(raw);
    if (handle && handle.length >= 2) labels.add(handle);
    const cleaned = cleanDisplayName(raw);
    if (cleaned && cleaned.length >= 2 && cleaned !== handle) labels.add(cleaned);
    const base = handle || cleaned;
    const first = base?.split(/\s+/)[0];
    if (first && first.length >= 3) labels.add(first);
  };

  add(member.displayName);
  add(member.preferredName);
  for (const n of [
    ...(member.nicknames ?? []),
    ...(member.tetoNicknames ?? []),
    ...(member.mentionAliases ?? [])
  ]) {
    add(n);
  }
  return [...labels].sort((a, b) => b.length - a.length);
}

/** Dígitos que o WhatsApp espera após @ no texto (telefone ou LID local). */
export function mentionMarkInText(member = {}) {
  const phone = String(member.waPhone ?? "").trim().replace(/@.+$/, "");
  if (phone && /^\d{10,15}$/.test(phone)) return phone;
  const lid = String(member.waLid ?? "").trim().replace(/@.+$/, "");
  if (lid && /^\d{10,}$/.test(lid)) return lid;
  const fromJid = extractLocalPart(member.mentionJid ?? "");
  if (fromJid && /^\d{8,}$/.test(fromJid)) return fromJid;
  const uid = String(member.userId ?? "").trim().replace(/@.+$/, "");
  if (uid && /^\d{8,}$/.test(uid)) return uid;
  return "";
}

/** JID para o array mentions do Baileys — prefere @s.whatsapp.net quando há telefone. */
export function bestMentionJid(member = {}) {
  const phone = String(member.waPhone ?? "").trim().replace(/@.+$/, "");
  if (phone && /^\d{10,15}$/.test(phone)) return `${phone}@s.whatsapp.net`;
  const jid = String(member.mentionJid ?? "").trim();
  if (jid.includes("@")) return jid;
  const lid = String(member.waLid ?? member.userId ?? "").trim().replace(/@.+$/, "");
  if (lid && /^\d{10,}$/.test(lid)) return `${lid}@lid`;
  return jid || null;
}

function labelMatchesPartialToken(labelKey, tokenKey) {
  if (!labelKey || !tokenKey || tokenKey.length < 3) return false;
  if (labelKey === tokenKey) return false;
  // @Kzer → Kzer0 (mín. 4 chars no token parcial)
  if (labelKey.startsWith(tokenKey)) return tokenKey.length >= 4;
  // @Kzer0 quando só Kzer está indexado
  if (tokenKey.startsWith(labelKey) && tokenKey.length > labelKey.length) return labelKey.length >= 3;
  return false;
}

function partialMatchScore(labelKey, tokenKey) {
  if (labelKey.startsWith(tokenKey)) return labelKey.length - tokenKey.length;
  if (tokenKey.startsWith(labelKey)) return tokenKey.length - labelKey.length;
  return 999;
}

function resolvePartialMention(tokenKey, members = []) {
  if (!tokenKey || tokenKey.length < 3) return null;

  const candidates = [];
  for (const member of members) {
    const jid = bestMentionJid(member) ?? member.mentionJid;
    if (!jid) continue;
    const labels = collectMentionableLabels(member);
    for (const label of labels) {
      const labelKey = normalizeMentionToken(label);
      if (!labelKey || !labelMatchesPartialToken(labelKey, tokenKey)) continue;
      candidates.push({
        member,
        labels,
        jid,
        label,
        labelKey,
        score: partialMatchScore(labelKey, tokenKey)
      });
    }
  }

  if (!candidates.length) return null;

  const jids = new Set(candidates.map((c) => c.jid));
  if (jids.size > 1) return null;

  candidates.sort((a, b) => a.score - b.score || a.labelKey.length - b.labelKey.length);
  const best = candidates[0];
  return {
    member: best.member,
    labels: best.labels,
    jid: best.jid,
    matchKind: "partial",
    matchedLabel: best.label
  };
}

/**
 * Índice tradutor: token normalizado (@gabbis) → membro + JID de menção real.
 * Várias grafias (@Gabbis, @gabbis, apelido) apontam para a mesma pessoa.
 */
export function buildMentionTranslator(members = []) {
  /** @type {Map<string, { member: object, labels: string[], jid: string }>} */
  const byToken = new Map();

  for (const member of members) {
    const jid = bestMentionJid(member);
    if (!jid) continue;
    const labels = collectMentionableLabels(member);
    const bucket = { member, labels, jid };
    for (const label of labels) {
      const key = normalizeMentionToken(label);
      if (!key) continue;
      if (!byToken.has(key)) byToken.set(key, bucket);
    }
  }

  return {
    byToken,
    members,
    resolveToken(token) {
      const key = normalizeMentionToken(token);
      if (!key) return null;

      const exact = byToken.get(key);
      if (exact) {
        return { ...exact, matchKind: "exact", matchedLabel: token };
      }

      return resolvePartialMention(key, members);
    },
    /** Tags sugeridas para o prompt — ex.: @Gabbis (também @gabbis) */
    promptTags() {
      const lines = [];
      const seen = new Set();
      for (const bucket of byToken.values()) {
        const id = bucket.member.userId;
        if (seen.has(id)) continue;
        seen.add(id);
        const primary = bucket.member.displayName;
        const alts = bucket.labels
          .filter((l) => normalizeMentionToken(l) !== normalizeMentionToken(primary))
          .slice(0, 4)
          .map((l) => `@${l}`);
        const altPart = alts.length ? ` (também ${alts.join(", ")})` : "";
        lines.push(`@${primary}${altPart}`);
      }
      return lines;
    }
  };
}

/**
 * Traduz @nome/@apelido → @dígitos no texto + array mentions (protocolo Baileys).
 * O WhatsApp só destaca menção quando o texto usa @número/LID e mentions[] tem o JID.
 */
export function translateAtMentions(text, members = []) {
  let out = String(text ?? "");
  if (!out || !members.length) {
    return { text: out, mentions: [], translations: [] };
  }

  const translator = buildMentionTranslator(members);
  const lookup = memberLookup(members);
  const mentions = [];
  const translations = [];
  const seenJids = new Set();

  const pushMention = (jid, meta = {}) => {
    if (!jid || seenJids.has(jid)) return;
    mentions.push(jid);
    seenJids.add(jid);
    if (meta.from && meta.to) translations.push(meta);
  };

  const resolveMember = (rawId) => {
    const id = String(rawId ?? "").trim();
    return lookup.get(id) ?? lookup.get(`dm-${id}`) ?? null;
  };

  // @telefone / @LID numérico → marca @dígitos + JID (protocolo Baileys)
  for (const member of members) {
    const jid = bestMentionJid(member) ?? member.mentionJid;
    if (!member?.userId || !jid) continue;
    const id = String(member.userId);
    const mark = mentionMarkInText(member);
    for (const [pattern, replacer] of [
      [new RegExp(`@${escapeRegExp(id)}(?!\\d)`, "g"), () => `@${mark || member.displayName}`],
      ...(member.waLid
        ? [[new RegExp(`@${escapeRegExp(member.waLid)}(?!\\d)`, "g"), () => `@${mark || member.displayName}`]]
        : []),
      ...(member.waPhone && member.waPhone !== id
        ? [[new RegExp(`@${escapeRegExp(member.waPhone)}(?!\\d)`, "g"), () => `@${mark || member.displayName}`]]
        : [])
    ]) {
      if (pattern.test(out)) {
        out = out.replace(pattern, replacer);
        pushMention(jid, { from: pattern.source, to: member.displayName, jid });
      }
    }
  }

  out = out.replace(/@(\d{8,})(?!\d)/g, (full, digits) => {
    const m = resolveMember(digits);
    if (!m) return full;
    const jid = bestMentionJid(m);
    const mark = mentionMarkInText(m) || digits;
    if (!jid) return full;
    pushMention(jid, { from: full, to: `@${mark}`, jid });
    return `@${mark}`;
  });

  // @nome / @apelido / @prefixo parcial — preserva grafia original no texto
  out = out.replace(/@([\p{L}\p{N}_'-]{2,32})/gu, (full, token) => {
    const hit = translator.resolveToken(token);
    if (!hit) return full;
    const mark = mentionMarkInText(hit.member);
    const jid = bestMentionJid(hit.member) ?? hit.jid;
    pushMention(jid, {
      from: full,
      to: mark ? `@${mark}` : hit.member.displayName,
      jid,
      matchedLabel: hit.matchedLabel ?? token,
      matchKind: hit.matchKind ?? "exact"
    });
    return mark ? `@${mark}` : full;
  });

  return { text: out, mentions, translations };
}

/** @deprecated alias — use translateAtMentions */
export function applyWhatsAppMentions(text, members = []) {
  const { text: t, mentions } = translateAtMentions(text, members);
  return { text: t, mentions };
}
