import {
  buildIdentityIndex,
  cleanDisplayName,
  isLikelyPhoneNumber,
  resolveIdentityEntry
} from "./waIdentity.js";
import { isBotIdentity } from "./botIdentity.js";
import { TETO_ENDEARMENTS } from "./profileFacts.js";

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
    .filter(
      (id) =>
        id &&
        id !== "teto" &&
        !id.startsWith("grp_") &&
        !id.startsWith("dm-") &&
        !isBotIdentity(runtime, id)
    )
    .map((userId) => {
      const nameInfo = resolveIdentityEntry(userId, identityIndex, runtime.groupMemory, channelId);
      const linkedPhone = phoneLinks[userId] ?? nameInfo.waPhone ?? null;
      const linkedLid = nameInfo.waLid ?? (/^\d{14,}$/.test(userId) ? userId : null);
      const mentionJid = mentionJidFor(userId, channel, nameInfo);
      const mentionAliases = [
        ...new Set(
          [
            nameInfo.preferredName,
            ...(nameInfo.nicknames ?? []),
            ...(nameInfo.tetoNicknames ?? [])
          ]
            .map(cleanDisplayName)
            .filter(Boolean)
        )
      ].filter((n) => n !== nameInfo.displayName);
      return {
        userId,
        displayName: nameInfo.displayName,
        preferredName: nameInfo.preferredName ?? null,
        nicknames: nameInfo.nicknames ?? [],
        tetoNicknames: nameInfo.tetoNicknames ?? [],
        mentionAliases,
        mentionJid,
        waPhone: linkedPhone,
        waLid: linkedLid,
        canonicalUserId: nameInfo.canonicalUserId ?? userId,
        nameSource: nameInfo.source ?? "profile"
      };
    })
    .filter((m) => m.displayName);

  // Dedup: manter apenas uma entrada por canonicalUserId (a mais informativa)
  const seen = new Map();
  for (const m of members) {
    const key = m.canonicalUserId || m.userId;
    if (!seen.has(key)) {
      seen.set(key, m);
    } else {
      // Prefere a entrada com waPhone E waLid
      const prev = seen.get(key);
      const score = (x) => (x.waPhone ? 1 : 0) + (x.waLid ? 1 : 0) + (x.tetoNicknames?.length ?? 0);
      if (score(m) > score(prev)) seen.set(key, m);
    }
  }
  const dedupedMembers = [...seen.values()];

  // Só o que é público no grupo: nome e variações do nome. Apelido carinhoso do PV, telefone e
  // LID ficam de fora — no grupo ninguém precisa saber como a Teto chama a pessoa no privado.
  const promptLines = dedupedMembers.map((m) => {
    const private_ = new Set((m.tetoNicknames ?? []).map((n) => String(n).toLowerCase()));
    const aliases = [...new Set([...(m.nicknames ?? []), ...(m.mentionAliases ?? [])])].filter((n) => {
      const lower = String(n ?? "").toLowerCase();
      return n && n !== m.displayName && !private_.has(lower) && !TETO_ENDEARMENTS.has(lower) && !isPhoneId(n);
    });
    return `- ${m.displayName}${aliases.length ? ` (também: ${aliases.join(", ")})` : ""} — marcar: @${m.displayName}`;
  });

  return { members: dedupedMembers, promptLines };
}

export function formatGroupRosterBlock(roster) {
  if (!roster?.promptLines?.length) return [];
  return [
    "[GRUPO — QUEM ESTÁ AQUI]",
    ...roster.promptLines,
    "Chame cada um pelo nome (ou pelo 'também:'). Apelido carinhoso e coisas que alguém te contou no privado NÃO aparecem aqui — não use nem comente no grupo.",
    "Nunca cite número de telefone ou id numérico; diga o nome (ex.: Gabbis, Duda).",
    "O número/LID da própria Teto (conta do bot) NÃO é um membro do grupo — não marque como se fosse Gabbis ou outra pessoa.",
    "TRADUTOR DE MENÇÕES: você pode escrever @Gabbis ou @gabbis (maiúscula/minúscula) — o sistema traduz para a menção real no WhatsApp.",
    "Prefixo parcial também vale se for único no grupo: @Kzer pode marcar quem se chama Kzer0 (desde que não haja outra pessoa com nome parecido).",
    "Apelidos listados (também:, Teto chama:) também funcionam com @ — ex.: @Kzer se for apelido da pessoa.",
    "Para marcar DE VERDADE (notificação azul), use @ antes do nome; sem @ é só texto comum."
  ];
}

export { cleanDisplayName } from "./waIdentity.js";
