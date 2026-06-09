import {
  buildIdentityIndex,
  cleanDisplayName,
  isLikelyPhoneNumber,
  resolveIdentityEntry
} from "./waIdentity.js";

function isPhoneId(id = "") {
  return isLikelyPhoneNumber(id);
}

/** Índice global telefone/userId/LID → melhor nome conhecido (PV + grupo). */
export function buildContactIndex(runtime) {
  return buildIdentityIndex(runtime);
}

function mentionJidFor(userId, channel, identityEntry) {
  const uid = String(userId ?? "").trim();
  const map = channel?.participantJids ?? {};
  if (map[uid]) return map[uid];
  if (identityEntry?.mentionJid) return identityEntry.mentionJid;
  if (identityEntry?.waLid) return `${identityEntry.waLid}@lid`;
  if (identityEntry?.waPhone) return `${identityEntry.waPhone}@s.whatsapp.net`;
  if (isPhoneId(uid)) return `${uid}@s.whatsapp.net`;
  if (/^\d{12,}$/.test(uid)) return `${uid}@lid`;
  if (uid.includes("@")) return uid;
  return null;
}

/**
 * Monta elenco do grupo com apelidos do PV + nomes vistos no grupo.
 */
export function buildGroupRoster(runtime, channelId, { participants = [] } = {}) {
  if (!channelId) return { members: [], promptLines: [] };

  const channel = runtime?.channelRegistry?.get?.(channelId) ?? {};
  const identityIndex = buildIdentityIndex(runtime);
  const phoneLinks = channel.participantPhones ?? {};
  const ids = new Set();

  for (const p of participants ?? []) {
    const id = String(p ?? "").trim();
    if (id) ids.add(id);
  }
  for (const p of channel.participants ?? []) {
    const id = String(p ?? "").trim();
    if (id) ids.add(id);
  }
  for (const [lid, phone] of Object.entries(phoneLinks)) {
    if (lid) ids.add(lid);
    if (phone) ids.add(phone);
  }

  for (const entry of runtime.groupMemory?.byChannel?.(channelId, { limit: 100 }) ?? []) {
    if (entry.userId) ids.add(String(entry.userId));
  }

  const members = [...ids]
    .filter((id) => id && id !== "teto" && !id.startsWith("grp_") && !id.startsWith("dm-"))
    .map((userId) => {
      const nameInfo = resolveIdentityEntry(userId, identityIndex, runtime.groupMemory, channelId);
      const linkedPhone = phoneLinks[userId] ?? nameInfo.waPhone ?? null;
      const linkedLid = nameInfo.waLid ?? (/^\d{14,}$/.test(userId) ? userId : null);
      const mentionJid = mentionJidFor(userId, channel, nameInfo);
      return {
        userId,
        displayName: nameInfo.displayName,
        preferredName: nameInfo.preferredName ?? null,
        nicknames: nameInfo.nicknames ?? [],
        tetoNicknames: nameInfo.tetoNicknames ?? [],
        mentionJid,
        waPhone: linkedPhone,
        waLid: linkedLid,
        canonicalUserId: nameInfo.canonicalUserId ?? userId,
        nameSource: nameInfo.source ?? "profile"
      };
    })
    .filter((m) => m.displayName);

  const promptLines = members.map((m) => {
    const nickParts = [];
    if (m.preferredName && m.preferredName !== m.displayName) {
      nickParts.push(`prefere: ${m.preferredName}`);
    }
    const userNicks = (m.nicknames ?? []).filter(
      (n) => n !== m.displayName && !(m.tetoNicknames ?? []).includes(n)
    );
    if (userNicks.length) nickParts.push(`também: ${userNicks.join(", ")}`);
    if ((m.tetoNicknames ?? []).length) {
      nickParts.push(`Teto chama: ${m.tetoNicknames.join(", ")}`);
    }
    const nickLine = nickParts.length ? ` (${nickParts.join(" | ")})` : "";
    const idParts = [];
    if (m.waLid) idParts.push(`LID ${m.waLid}`);
    if (m.waPhone) idParts.push(`tel ${m.waPhone}`);
    if (!idParts.length) idParts.push(`id ${m.userId}`);
    return `- ${m.displayName}${nickLine} — ${idParts.join(" ↔ ")} — marcar no zap: @${m.displayName}`;
  });

  return { members, promptLines };
}

export function formatGroupRosterBlock(roster) {
  if (!roster?.promptLines?.length) return [];
  return [
    "[GRUPO — QUEM ESTÁ AQUI]",
    ...roster.promptLines,
    "LID, telefone e apelidos são a MESMA pessoa quando listados juntos — use sempre o NOME.",
    "Apelidos que a Teto deu (Teto chama: ...) ou que a pessoa pediu (prefere: ...) valem no grupo.",
    "Nunca cite @187995... ou id numérico cru; diga o nome (ex.: Gabbis, Duda).",
    "Para marcar alguém de verdade no WhatsApp, escreva @Nome exatamente como listado."
  ];
}

export { cleanDisplayName } from "./waIdentity.js";
