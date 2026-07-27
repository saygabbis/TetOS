import {
  botIdentityIds,
  isBotIdentity,
  sanitizeIdentityAliases
} from "./botIdentity.js";
import { isOwnerContact, dmUserId, normalizeJidKey } from "./userActivity.js";

/** "Gabbis( ˘ ³˘ )♥" → "Gabbis" */
export function cleanDisplayName(raw = "") {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const m = s.match(/^([\p{L}][\p{L}\s'-]{0,28})/u);
  return (m ? m[1] : s).trim().replace(/\s+/g, " ");
}

export function extractLocalPart(jidOrId = "") {
  return String(jidOrId ?? "")
    .split(":")[0]
    .replace(/@.+$/, "")
    .trim();
}

/** Telefone internacional plausível (não LID longo sem código de país claro). */
export function isLikelyPhoneNumber(id = "") {
  const s = String(id ?? "").trim();
  if (!/^\d{10,15}$/.test(s)) return false;
  if (/^55\d{10,11}$/.test(s)) return true;
  if (/^62\d{9,12}$/.test(s)) return true;
  if (/^1\d{10}$/.test(s)) return true;
  if (s.length <= 13 && /^[1-9]\d{9,12}$/.test(s)) return true;
  return false;
}

export function classifyWaLocalId(local = "", fullJid = "") {
  const id = extractLocalPart(local);
  const jid = String(fullJid ?? "").toLowerCase();
  if (!id) return "unknown";
  if (jid.includes("@lid")) return "lid";
  if (jid.includes("@s.whatsapp.net")) return "phone";
  if (isLikelyPhoneNumber(id)) return "phone";
  if (/^\d{14,}$/.test(id)) return "lid";
  if (/^\d{8,}$/.test(id)) return "ambiguous";
  return "unknown";
}

export function identityAliasKeys(userId = "", facts = {}) {
  const keys = new Set();
  const uid = String(userId ?? "").trim();
  if (uid) keys.add(uid);

  const phone = String(facts.waPhone ?? "").trim();
  const lid = String(facts.waLid ?? "").trim();
  const remote = String(facts.waRemoteJid ?? "").trim();

  if (phone) keys.add(phone);
  if (lid) {
    keys.add(lid);
    keys.add(`dm-${lid}`);
  }
  if (uid.startsWith("dm-")) {
    keys.add(uid.slice(3));
    keys.add(extractLocalPart(uid.slice(3)));
  }
  if (remote) {
    keys.add(extractLocalPart(remote));
    keys.add(dmUserId(remote));
  }
  for (const a of facts.identityAliases ?? []) {
    const k = String(a ?? "").trim();
    if (k) keys.add(k);
  }
  for (const n of facts.nicknames ?? []) {
    const nick = cleanDisplayName(n);
    if (nick) keys.add(nick.toLowerCase());
  }
  for (const n of facts.tetoNicknames ?? []) {
    const nick = cleanDisplayName(n);
    if (nick) keys.add(nick.toLowerCase());
  }
  return [...keys];
}

/** Nomes/apelidos conhecidos de um contato (push, PV, grupo, apelidos da Teto). */
export function collectNameVariants(facts = {}) {
  const raw = [
    facts.preferredName,
    facts.displayName,
    facts.name,
    ...(Array.isArray(facts.nicknames) ? facts.nicknames : []),
    ...(Array.isArray(facts.tetoNicknames) ? facts.tetoNicknames : [])
  ];
  const cleaned = raw.map((n) => cleanDisplayName(n)).filter(Boolean);
  const unique = [...new Set(cleaned)];
  const displayName =
    cleanDisplayName(facts.preferredName) ||
    cleanDisplayName(facts.displayName) ||
    cleanDisplayName(facts.name) ||
    unique[0] ||
    null;
  const preferredName = cleanDisplayName(facts.preferredName) || null;
  const userNicknames = unique.filter(
    (n) => n !== displayName && !(facts.tetoNicknames ?? []).map(cleanDisplayName).includes(n)
  );
  const tetoNicknames = (facts.tetoNicknames ?? []).map(cleanDisplayName).filter(Boolean);
  return {
    displayName,
    preferredName,
    nicknames: unique,
    userNicknames,
    tetoNicknames
  };
}

export function mergeProfileNicknames(existingFacts = {}, { userNick = null, tetoNick = null, pushName = null } = {}) {
  const nicknames = new Set(
    (existingFacts.nicknames ?? [])
      .map(cleanDisplayName)
      .filter(Boolean)
  );
  const tetoNicknames = new Set(
    (existingFacts.tetoNicknames ?? [])
      .map(cleanDisplayName)
      .filter(Boolean)
  );

  const addUser = (n) => {
    const c = cleanDisplayName(n);
    if (c && c.length >= 2) nicknames.add(c);
  };
  const addTeto = (n) => {
    const c = cleanDisplayName(n);
    if (c && c.length >= 2) {
      tetoNicknames.add(c);
      nicknames.add(c);
    }
  };

  if (pushName) addUser(pushName);
  if (userNick) {
    addUser(userNick);
    existingFacts.preferredName = cleanDisplayName(userNick) || existingFacts.preferredName;
  }
  if (tetoNick) addTeto(tetoNick);

  return {
    ...existingFacts,
    nicknames: [...nicknames],
    tetoNicknames: [...tetoNicknames]
  };
}

/** Persiste apelido novo (usuário ou Teto) em todos os ids ligados. */
export function addProfileNicknames(
  runtime,
  userId,
  { userNick = null, tetoNick = null, pushName = null } = {},
  channelScope = null
) {
  const profileKey = String(userId ?? "").trim();
  if (!profileKey || !runtime?.longTerm?.updateProfile) return;

  const existing = runtime.longTerm.getProfile?.(profileKey)?.facts ?? {};
  const merged = mergeProfileNicknames(existing, { userNick, tetoNick, pushName });

  runtime.longTerm.updateProfile(profileKey, { facts: merged }, channelScope);

  for (const alias of identityAliasKeys(profileKey, merged)) {
    if (alias === profileKey) continue;
    const aliasFacts = runtime.longTerm.getProfile?.(alias)?.facts ?? {};
    runtime.longTerm.updateProfile(
      alias,
      {
        facts: mergeProfileNicknames(aliasFacts, {
          userNick: merged.preferredName ?? userNick,
          tetoNick,
          pushName: null
        })
      },
      channelScope
    );
  }
}

/** Captura vocativo no início da bolha da Teto (ex.: "Gabi, ..." / "bb "). */
export function captureTetoNicknamesFromReplies(replies = [], { displayName = null, existing = [] } = {}) {
  const found = new Set((existing ?? []).map(cleanDisplayName).filter(Boolean));
  const base = cleanDisplayName(displayName)?.toLowerCase();

  for (const reply of replies ?? []) {
    const text = String(reply ?? "").trim();
    if (!text) continue;

    const vocative = text.match(/^([\p{L}][\p{L}'-]{1,24})[,!?.\s—-]/u);
    if (vocative?.[1]) {
      const nick = cleanDisplayName(vocative[1]);
      if (nick && nick.length >= 2 && nick.toLowerCase() !== base) {
        found.add(nick);
      }
    }

    const affectionCompound = text.match(
      /\b(?:minha|meu)\s+(?:princesa|príncipe|amor|beb[eê]|bb)\s+([\p{L}][\p{L}'-]{1,20})\b/iu
    );
    if (affectionCompound?.[1]) {
      const nick = cleanDisplayName(affectionCompound[1]);
      if (nick && nick.length >= 2 && nick.toLowerCase() !== base) {
        found.add(nick);
      }
    }

    const affectionSimple = text.match(/\b(?:minha|meu)\s+([\p{L}][\p{L}'-]{1,20})\b/iu);
    if (affectionSimple?.[1]) {
      const skip = new Set(["princesa", "príncipe", "principe", "amor", "bebê", "bebe", "bb"]);
      const nick = cleanDisplayName(affectionSimple[1]);
      if (nick && nick.length >= 2 && !skip.has(nick.toLowerCase()) && nick.toLowerCase() !== base) {
        found.add(nick);
      }
    }
  }

  return [...found];
}

/**
 * Persiste vínculo telefone ↔ LID ↔ dm-* no perfil e no canal do grupo.
 */
export function recordWaIdentity(
  runtime,
  {
    userId,
    remoteJid = null,
    participantJid = null,
    participantPhone = null,
    pushName = null,
    channelId = null,
    isGroup = false
  } = {}
) {
  const profileKey = String(userId ?? "").trim();
  if (!profileKey || !runtime?.longTerm?.updateProfile) return;

  const existing = runtime.longTerm.getProfile?.(profileKey)?.facts ?? {};
  const facts = { ...existing };
  const dmJid = !isGroup && remoteJid ? normalizeJidKey(remoteJid) : "";
  const partJid = participantJid || (isGroup ? participantJid : dmJid) || "";
  const partLocal = extractLocalPart(partJid);
  const partKind = classifyWaLocalId(partLocal, partJid);

  const phoneLocal = extractLocalPart(participantPhone);
  if (phoneLocal && isLikelyPhoneNumber(phoneLocal)) {
    facts.waPhone = phoneLocal;
  } else if (partKind === "phone" && isLikelyPhoneNumber(partLocal)) {
    facts.waPhone = partLocal;
  }

  if (partKind === "lid" && partLocal) {
    facts.waLid = partLocal;
    facts.waRemoteJid = partJid.includes("@") ? partJid : `${partLocal}@lid`;
  } else if (dmJid.includes("@lid")) {
    facts.waLid = extractLocalPart(dmJid);
    facts.waRemoteJid = dmJid;
  }

  if (remoteJid) facts.waRemoteJid = normalizeJidKey(remoteJid);
  if (pushName) {
    facts.name = pushName;
    facts.displayName = cleanDisplayName(pushName) || facts.displayName;
  }
  Object.assign(facts, mergeProfileNicknames(facts, { pushName }));

  facts.identityAliases = sanitizeIdentityAliases(
    [
      ...new Set([
        ...identityAliasKeys(profileKey, facts),
        ...identityAliasKeys(profileKey, existing)
      ])
    ],
    runtime,
    profileKey
  );

  runtime.longTerm.updateProfile(profileKey, { facts });

  for (const alias of facts.identityAliases) {
    if (alias === profileKey) continue;
    if (isBotIdentity(runtime, alias) !== isBotIdentity(runtime, profileKey)) continue;
    const aliasProfile = runtime.longTerm.getProfile?.(alias)?.facts ?? {};
    runtime.longTerm.updateProfile(alias, {
      facts: {
        ...aliasProfile,
        ...(facts.waPhone ? { waPhone: facts.waPhone } : {}),
        ...(facts.waLid ? { waLid: facts.waLid, waRemoteJid: facts.waRemoteJid } : {}),
        ...(facts.displayName && !aliasProfile.displayName
          ? { displayName: facts.displayName, name: facts.name ?? pushName }
          : {}),
        identityAliases: sanitizeIdentityAliases(
          [...new Set([...(aliasProfile.identityAliases ?? []), ...facts.identityAliases])],
          runtime,
          alias
        )
      }
    });
  }

  if (channelId && isGroup && runtime.channelRegistry?.recordParticipantJid) {
    if (facts.waPhone) {
      runtime.channelRegistry.recordParticipantJid(
        channelId,
        facts.waPhone,
        `${facts.waPhone}@s.whatsapp.net`
      );
    }
    if (facts.waLid) {
      runtime.channelRegistry.recordParticipantJid(
        channelId,
        facts.waLid,
        facts.waRemoteJid || `${facts.waLid}@lid`
      );
      runtime.channelRegistry.recordParticipantJid(
        channelId,
        `dm-${facts.waLid}`,
        facts.waRemoteJid || `${facts.waLid}@lid`
      );
    }
    if (facts.waPhone && facts.waLid) {
      runtime.channelRegistry.recordParticipantLink?.(channelId, facts.waLid, facts.waPhone);
    }
  }
}

/** Índice unificado: qualquer id (tel, LID, dm-*) → nome + ids canônicos. */
export function buildIdentityIndex(runtime) {
  const index = new Map();
  const profiles = runtime?.longTerm?.data?.profiles ?? {};

  const put = (key, entry) => {
    const k = String(key ?? "").trim();
    if (!k || !entry?.displayName) return;
    const prev = index.get(k);
    if (
      !prev ||
      entry.preferredName ||
      (entry.canonicalUserId && !prev.canonicalUserId) ||
      entry.displayName.length < prev.displayName.length
    ) {
      index.set(k, { ...prev, ...entry, aliases: [...new Set([...(prev?.aliases ?? []), ...(entry.aliases ?? []), k])] });
    }
  };

  for (const [profileKey, prof] of Object.entries(profiles)) {
    if (isBotIdentity(runtime, profileKey)) continue;
    const facts = prof?.facts ?? {};
    const names = collectNameVariants(facts);
    if (!names.displayName) continue;

    const entry = {
      displayName: names.displayName,
      preferredName: names.preferredName,
      nicknames: names.nicknames,
      tetoNicknames: names.tetoNicknames,
      canonicalUserId: profileKey,
      waPhone: facts.waPhone ?? null,
      waLid: facts.waLid ?? null,
      mentionJid: facts.waRemoteJid ?? null,
      aliases: identityAliasKeys(profileKey, facts)
    };

    for (const alias of entry.aliases) {
      put(alias, entry);
    }
    for (const nick of names.nicknames) {
      put(nick, entry);
      put(nick.toLowerCase(), entry);
    }
    if (facts.waPhone) put(facts.waPhone, { ...entry, mentionJid: `${facts.waPhone}@s.whatsapp.net` });
    if (facts.waLid) {
      put(facts.waLid, { ...entry, mentionJid: `${facts.waLid}@lid` });
      put(`dm-${facts.waLid}`, entry);
    }
  }

  const botIds = botIdentityIds(runtime);
  const botPhone = String(
    runtime?.whatsappBotPhoneE164 ?? runtime?.defaults?.botWaPhone ?? ""
  )
    .replace(/\D/g, "")
    .trim();
  if (botIds.size) {
    const selfEntry = {
      displayName: "Teto",
      preferredName: "Teto",
      canonicalUserId: "teto",
      waPhone: botPhone || null,
      mentionJid: botPhone ? `${botPhone}@s.whatsapp.net` : null,
      aliases: [...botIds],
      isSelf: true,
      source: "bot_self"
    };
    for (const id of botIds) {
      put(id, selfEntry);
      if (id.startsWith("dm-")) put(id.slice(3), selfEntry);
    }
    for (const jid of runtime?.defaults?.botWaJids ?? []) {
      const local = extractLocalPart(jid);
      if (!local) continue;
      put(local, { ...selfEntry, mentionJid: jid.includes("@") ? jid : `${local}@lid` });
      put(`dm-${local}`, selfEntry);
    }
  }

  const ownerPhone = String(runtime?.defaults?.learningTargetUserId ?? "").trim();
  if (ownerPhone) {
    for (const [profileKey, prof] of Object.entries(profiles)) {
      if (!isOwnerContact(runtime, null, profileKey)) continue;
      const facts = prof?.facts ?? {};
      const displayName =
        cleanDisplayName(facts.preferredName) ||
        cleanDisplayName(facts.displayName) ||
        cleanDisplayName(facts.name) ||
        "Gabbis";
      const ownerEntry = {
        displayName,
        preferredName: facts.preferredName ? cleanDisplayName(facts.preferredName) : null,
        canonicalUserId: profileKey,
        waPhone: ownerPhone,
        waLid: facts.waLid ?? null,
        mentionJid: facts.waRemoteJid ?? `${ownerPhone}@s.whatsapp.net`,
        aliases: identityAliasKeys(profileKey, facts),
        source: "owner_link"
      };
      put(ownerPhone, ownerEntry);
      for (const alias of ownerEntry.aliases) {
        put(alias, ownerEntry);
      }
    }
  }

  return index;
}

export function resolveIdentityEntry(userId, identityIndex, groupMemory, channelId) {
  const uid = String(userId ?? "").trim();
  let entry = identityIndex.get(uid);
  if (entry) return { ...entry, userId: uid };

  if (uid.startsWith("dm-")) {
    entry = identityIndex.get(uid.slice(3)) ?? identityIndex.get(uid);
    if (entry) return { ...entry, userId: uid };
  }

  const fromMemory = (groupMemory?.byChannel?.(channelId, { limit: 80 }) ?? []).find(
    (e) => e.userId === uid && e.speakerName
  );
  if (fromMemory?.speakerName) {
    return {
      displayName: cleanDisplayName(fromMemory.speakerName),
      preferredName: null,
      canonicalUserId: uid,
      userId: uid,
      source: "group_memory"
    };
  }

  if (isLikelyPhoneNumber(uid)) {
    return {
      displayName: `pessoa_${uid.slice(-4)}`,
      canonicalUserId: uid,
      userId: uid,
      waPhone: uid,
      source: "phone_fallback"
    };
  }

  return {
    displayName: `contato_${uid.slice(-6)}`,
    canonicalUserId: uid,
    userId: uid,
    waLid: /^\d{12,}$/.test(uid) ? uid : null,
    source: "lid_fallback"
  };
}

/** Substitui @6283... / @187995... por @Nome antes do modelo ler. */
export function normalizeIncomingMentions(text = "", identityIndex, mentionedJids = []) {
  let out = String(text ?? "");
  if (!out) return out;

  const replaceLocal = (local) => {
    const id = extractLocalPart(local);
    if (!id) return null;
    const entry =
      identityIndex.get(id) ??
      identityIndex.get(`dm-${id}`) ??
      identityIndex.get(`dm-${id}@lid`);
    if (!entry?.displayName) return null;
    if (entry.isSelf) {
      const re = new RegExp(`@${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "g");
      if (re.test(out)) out = out.replace(re, "@Teto");
      return entry;
    }
    const re = new RegExp(`@${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "g");
    if (re.test(out)) {
      out = out.replace(re, `@${entry.displayName}`);
    }
    return entry;
  };

  for (const jid of mentionedJids ?? []) {
    replaceLocal(jid);
  }

  out = out.replace(/@(\d{8,})(?!\d)/g, (full, digits) => {
    const entry =
      identityIndex.get(digits) ??
      identityIndex.get(`dm-${digits}`);
    if (entry?.isSelf) return "@Teto";
    return entry?.displayName ? `@${entry.displayName}` : full;
  });

  for (const [key, entry] of identityIndex.entries()) {
    if (!entry?.displayName || /^\d+$/.test(key)) continue;
    if (key === entry.displayName || key === entry.displayName.toLowerCase()) continue;
    const re = new RegExp(`@${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "gi");
    if (re.test(out)) {
      out = out.replace(re, `@${entry.displayName}`);
    }
  }

  return out;
}

/** Todos os ids do mesmo contato (memória + ativação). */
export function linkedIdentityIds(runtime, userId) {
  const uid = String(userId ?? "").trim();
  if (!uid) return ["default"];
  if (isBotIdentity(runtime, uid)) return ["teto"];

  const ids = new Set([uid]);
  const prof = runtime?.longTerm?.getProfile?.(uid)?.facts ?? {};
  for (const alias of identityAliasKeys(uid, prof)) {
    if (!isBotIdentity(runtime, alias)) ids.add(alias);
  }

  for (const [profileKey, profile] of Object.entries(runtime?.longTerm?.data?.profiles ?? {})) {
    if (isBotIdentity(runtime, profileKey)) continue;
    const aliases = profile?.facts?.identityAliases ?? [];
    if (aliases.includes(uid) || profileKey === uid) {
      ids.add(profileKey);
      for (const a of aliases) {
        if (!isBotIdentity(runtime, a)) ids.add(a);
      }
    }
  }

  return [...ids].filter((id) => id && !isBotIdentity(runtime, id));
}
