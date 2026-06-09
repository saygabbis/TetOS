import { isOwnerContact } from "./userActivity.js";

/** "Gabbis( ˘ ³˘ )♥" → "Gabbis" */
export function cleanDisplayName(raw = "") {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const m = s.match(/^([\p{L}][\p{L}\s'-]{0,28})/u);
  return (m ? m[1] : s).trim().replace(/\s+/g, " ");
}

function isPhoneId(id = "") {
  return /^\d{8,}$/.test(String(id ?? "").trim());
}

/** Índice global telefone/userId → melhor nome conhecido (PV + grupo). */
export function buildContactIndex(runtime) {
  const index = new Map();
  const profiles = runtime?.longTerm?.data?.profiles ?? {};
  const ownerPhone = String(runtime?.defaults?.learningTargetUserId ?? "").trim();

  const put = (id, entry) => {
    const key = String(id ?? "").trim();
    if (!key || !entry?.displayName) return;
    const prev = index.get(key);
    if (!prev || entry.preferredName || (entry.displayName.length < prev.displayName.length)) {
      index.set(key, {
        displayName: entry.displayName,
        preferredName: entry.preferredName ?? prev?.preferredName ?? null,
        source: entry.source ?? prev?.source ?? "profile"
      });
    }
  };

  for (const [profileKey, prof] of Object.entries(profiles)) {
    const facts = prof?.facts ?? {};
    const preferred = facts.preferredName ? cleanDisplayName(facts.preferredName) : null;
    const fromName = cleanDisplayName(facts.name);
    const displayName = preferred || fromName;
    if (!displayName) continue;

    const entry = {
      displayName,
      preferredName: preferred,
      source: preferred ? "preferred_name" : "push_name"
    };

    if (isPhoneId(profileKey)) put(profileKey, entry);
    if (facts.waPhone) put(String(facts.waPhone), entry);

    if (profileKey.startsWith("dm-")) {
      put(profileKey, entry);
      const local = profileKey.slice(3).split("@")[0];
      if (isPhoneId(local)) put(local, entry);
    }
  }

  if (ownerPhone) {
    for (const [profileKey, prof] of Object.entries(profiles)) {
      if (!isOwnerContact(runtime, null, profileKey)) continue;
      const facts = prof?.facts ?? {};
      const displayName =
        cleanDisplayName(facts.preferredName) ||
        cleanDisplayName(facts.name) ||
        "Gabbis";
      put(ownerPhone, { displayName, preferredName: facts.preferredName ?? null, source: "owner_link" });
    }
  }

  return index;
}

function resolveMemberName(userId, contactIndex, groupMemory, channelId) {
  const uid = String(userId ?? "").trim();
  const indexed = contactIndex.get(uid);
  if (indexed?.displayName) return { ...indexed, userId: uid };

  const fromMemory = (groupMemory?.byChannel?.(channelId, { limit: 80 }) ?? [])
    .find((e) => e.userId === uid && e.speakerName);
  if (fromMemory?.speakerName) {
    return {
      displayName: cleanDisplayName(fromMemory.speakerName),
      preferredName: null,
      source: "group_memory",
      userId: uid
    };
  }

  if (uid.startsWith("dm-")) {
    const indexedDm = contactIndex.get(uid);
    if (indexedDm) return { ...indexedDm, userId: uid };
  }

  return {
    displayName: isPhoneId(uid) ? `pessoa_${uid.slice(-4)}` : uid.slice(0, 16),
    preferredName: null,
    source: "unknown",
    userId: uid
  };
}

function mentionJidFor(userId, channel) {
  const uid = String(userId ?? "").trim();
  const map = channel?.participantJids ?? {};
  if (map[uid]) return map[uid];
  if (isPhoneId(uid)) return `${uid}@s.whatsapp.net`;
  if (uid.includes("@")) return uid;
  return null;
}

/**
 * Monta elenco do grupo com apelidos do PV + nomes vistos no grupo.
 */
export function buildGroupRoster(runtime, channelId, { participants = [] } = {}) {
  if (!channelId) return { members: [], promptLines: [] };

  const channel = runtime?.channelRegistry?.get?.(channelId) ?? {};
  const contactIndex = buildContactIndex(runtime);
  const ids = new Set();

  for (const p of participants ?? []) {
    const id = String(p ?? "").trim();
    if (id) ids.add(id);
  }
  for (const p of channel.participants ?? []) {
    const id = String(p ?? "").trim();
    if (id) ids.add(id);
  }

  for (const entry of runtime.groupMemory?.byChannel?.(channelId, { limit: 100 }) ?? []) {
    if (entry.userId) ids.add(String(entry.userId));
  }

  const members = [...ids]
    .filter((id) => id && id !== "teto" && !id.startsWith("grp_"))
    .map((userId) => {
      const nameInfo = resolveMemberName(userId, contactIndex, runtime.groupMemory, channelId);
      const mentionJid = mentionJidFor(userId, channel);
      return {
        userId,
        displayName: nameInfo.displayName,
        preferredName: nameInfo.preferredName,
        mentionJid,
        nameSource: nameInfo.source
      };
    })
    .filter((m) => m.displayName);

  const promptLines = members.map((m) => {
    const nick =
      m.preferredName && m.preferredName !== m.displayName
        ? ` (apelido PV: ${m.preferredName})`
        : m.nameSource === "owner_link"
          ? " (contato próximo — use o apelido dela)"
          : "";
    return `- ${m.displayName}${nick} — id interno ${m.userId} — para marcar no zap escreva @${m.displayName}`;
  });

  return { members, promptLines };
}

export function formatGroupRosterBlock(roster) {
  if (!roster?.promptLines?.length) return [];
  return [
    "[GRUPO — QUEM ESTÁ AQUI]",
    ...roster.promptLines,
    "Use SEMPRE o nome/apelido acima — nunca cite número cru (@6283... ou id longo).",
    "Para marcar alguém de verdade no WhatsApp, escreva @Nome exatamente como listado (ex.: @Gabbis).",
    "Se conhece apelido do PV com a pessoa, use esse apelido aqui no grupo também."
  ];
}
