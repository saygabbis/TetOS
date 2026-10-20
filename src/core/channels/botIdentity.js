import { dmJidForLocalId, dmUserId, isBogusLidJid, normalizeJidKey, ownerIdentityIds } from "./userActivity.js";
import { extractLocalPart, identityAliasKeys, isLikelyPhoneNumber } from "./waIdentity.js";
import {
  filterIdentityAliasTokens,
  isIdentityIdLike,
  isPlausibleHumanNickname,
  isTetoNicknameCandidate,
  isWhatsAppGroupIdAlias,
  sanitizeProfileNicknames
} from "./profileFacts.js";

/** IDs da própria Teto (conta WhatsApp do bot) — NÃO são contatos humanos. */
export function botIdentityIds(runtime) {
  const ids = new Set(["teto", "self"]);

  const phone = String(
    runtime?.whatsappBotPhoneE164 ?? runtime?.defaults?.botWaPhone ?? ""
  )
    .replace(/\D/g, "")
    .trim();
  if (phone) {
    ids.add(phone);
    ids.add(`dm-${phone}`);
  }

  for (const jid of runtime?.defaults?.botWaJids ?? []) {
    const key = normalizeJidKey(jid);
    if (!key) continue;
    ids.add(dmUserId(jid));
    const local = extractLocalPart(key);
    if (local) {
      ids.add(local);
      ids.add(`dm-${local}`);
    }
  }

  return ids;
}

export function isBotIdentity(runtime, userId = "", remoteJid = null) {
  const ids = botIdentityIds(runtime);
  if (!ids.size) return false;

  const uid = String(userId ?? "").trim();
  if (uid && ids.has(uid)) return true;
  if (uid.startsWith("dm-") && ids.has(uid.slice(3))) return true;
  if (uid && !uid.startsWith("dm-") && ids.has(`dm-${uid}`)) return true;

  if (remoteJid) {
    const dm = dmUserId(remoteJid);
    if (ids.has(dm)) return true;
    const local = normalizeJidKey(remoteJid).replace(/@.+$/, "");
    if (local && ids.has(local)) return true;
    if (local && ids.has(`dm-${local}`)) return true;
  }

  return false;
}

/** Remove aliases que cruzam bot ↔ humano (ex.: "gabbis" no perfil do número da Teto). */
export function sanitizeIdentityAliases(aliases = [], runtime, profileKey = "") {
  const botIds = botIdentityIds(runtime);
  const ownerIds = ownerIdentityIds(runtime);
  const isBot = isBotIdentity(runtime, profileKey);
  const isOwner = ownerIds.has(profileKey) || ownerIds.has(String(profileKey).replace(/^dm-/, ""));

  const base = [...new Set(aliases.map((a) => String(a ?? "").trim()).filter(Boolean))].filter((alias) => {
    const lower = alias.toLowerCase();
    if (isBot) {
      if (ownerIds.has(alias) || ownerIds.has(`dm-${alias}`)) return false;
      if (lower === "gabbis" || lower === "gabbi") return false;
    }
    if (!isBot && botIds.has(alias)) return false;
    if (isOwner && botIds.has(alias)) return false;
    if (!isBot && !isOwner && (lower === "gabbis" || lower === "gabbi")) return false;
    return true;
  });

  return filterIdentityAliasTokens(base, runtime, profileKey);
}

/** Chave canônica para persistir parceiro/owner — evita duplicar dm-tel vs dm-lid. */
export function resolveCanonicalHumanUserId(runtime, userId, { remoteJid = null, preferOwner = false } = {}) {
  const uid = String(userId ?? "").trim();
  if (!uid || isBotIdentity(runtime, uid, remoteJid)) return null;

  const ownerIds = ownerIdentityIds(runtime);
  const ownerPhone = String(runtime?.defaults?.learningTargetUserId ?? "").trim();

  if (preferOwner || ownerIds.has(uid) || ownerIds.has(uid.replace(/^dm-/, ""))) {
    if (ownerPhone) return `dm-${ownerPhone}`;
    for (const id of ownerIds) {
      if (id.startsWith("dm-")) return id;
    }
  }

  if (uid.startsWith("dm-")) return uid;
  if (remoteJid && !String(remoteJid).endsWith("@g.us")) {
    return dmUserId(remoteJid, uid);
  }
  return uid;
}

export function buildBotActorIds(runtime, botPhone = "", botJid = "") {
  const ids = new Set(["teto", "self"]);
  for (const id of botIdentityIds(runtime)) ids.add(id);
  const phone = String(botPhone ?? "").replace(/\D/g, "").trim();
  if (phone) {
    ids.add(phone);
    ids.add(`dm-${phone}`);
  }
  const local = extractLocalPart(botJid);
  if (local) {
    ids.add(local);
    ids.add(`dm-${local}`);
  }
  return ids;
}

/** waPhone/waLid só pertencem ao perfil se batem com a própria chave (senão vieram de propagação cruzada). */
function trustedIdentityFacts(facts, profileKey, isOwner, runtime) {
  const next = { ...facts };
  const keyLocal = String(profileKey).split("::")[0].replace(/^dm-/, "");
  // Telefone gravado como LID ("<tel>@lid") vinha de iniciativa com JID errado.
  if (next.waLid && isLikelyPhoneNumber(next.waLid)) {
    if (!next.waPhone) next.waPhone = next.waLid;
    delete next.waLid;
  }
  if (next.waRemoteJid && isBogusLidJid(next.waRemoteJid)) next.waRemoteJid = dmJidForLocalId(next.waRemoteJid);
  if (next.lastDmSessionId && isBogusLidJid(String(next.lastDmSessionId).replace(/^wa-dm:/, ""))) delete next.lastDmSessionId;
  if (isOwner) {
    const ownerJid = normalizeJidKey(runtime?.defaults?.ownerWaJids?.[0] ?? "");
    const ownerPhone = String(runtime?.defaults?.learningTargetUserId ?? "").trim();
    if (ownerPhone) next.waPhone = ownerPhone;
    if (ownerJid.endsWith("@lid")) {
      next.waLid = ownerJid.replace(/@.+$/, "");
      next.waRemoteJid = ownerJid;
    }
    return next;
  }
  if ((next.waPhone || next.waLid) && keyLocal !== next.waPhone && keyLocal !== next.waLid) {
    delete next.waPhone;
    delete next.waLid;
  }
  if (next.waRemoteJid && !String(next.waRemoteJid).endsWith("@g.us")) {
    const remoteLocal = extractLocalPart(next.waRemoteJid);
    if (remoteLocal !== keyLocal && remoteLocal !== next.waPhone && remoteLocal !== next.waLid) {
      delete next.waRemoteJid;
    }
  }
  return next;
}

/**
 * Limpa aliases cruzados e apelidos espúrios em perfis já salvos. Idempotente e grava uma vez só
 * (antes regravava o memory.json inteiro por perfil reparado).
 */
export function repairProfileContamination(runtime) {
  const longTerm = runtime?.longTerm;
  const profiles = longTerm?.data?.profiles;
  if (!profiles) return { repaired: 0 };

  const ownerIds = ownerIdentityIds(runtime);
  let repaired = 0;
  for (const [profileKey, profile] of Object.entries(profiles)) {
    const facts = profile?.facts ?? {};
    const baseKey = String(profileKey).split("::")[0];
    const isOwner = ownerIds.has(baseKey) || ownerIds.has(baseKey.replace(/^dm-/, ""));
    const isBot = isBotIdentity(runtime, baseKey);

    const trusted = isBot ? { ...facts } : trustedIdentityFacts(facts, profileKey, isOwner, runtime);
    const derived = identityAliasKeys(baseKey, { ...trusted, identityAliases: [] });
    const seed = isBot
      ? (facts.identityAliases ?? [])
      : isOwner
        ? [...derived, ...ownerIds]
        : derived;
    const identityAliases = sanitizeIdentityAliases([...new Set(seed)], runtime, baseKey);
    const next = { ...trusted, identityAliases };

    if (!isBot) {
      const display = facts.preferredName || facts.displayName || facts.name || null;
      if (next.preferredName && !isPlausibleHumanNickname(next.preferredName)) delete next.preferredName;
      const knownNames = [facts.displayName, facts.name, next.preferredName].filter(Boolean);
      const oldTeto = (facts.tetoNicknames ?? []).map((n) => String(n));
      const keptTeto = oldTeto.filter((n) => isTetoNicknameCandidate(n, { displayName: display, knownNames }));
      const droppedTeto = new Set(oldTeto.filter((n) => !keptTeto.includes(n)).map((n) => n.toLowerCase()));
      next.tetoNicknames = sanitizeProfileNicknames(keptTeto, { displayName: display });
      next.nicknames = sanitizeProfileNicknames(
        (facts.nicknames ?? []).filter((n) => !droppedTeto.has(String(n).toLowerCase())),
        { displayName: display }
      );
    }

    if (JSON.stringify(next) === JSON.stringify(facts)) continue;
    profiles[profileKey] = { ...profile, facts: next };
    repaired += 1;
  }
  if (repaired > 0) longTerm.persist?.();
  return { repaired };
}

/**
 * Remove perfis-artefato com chave de palavra ("oi", "kkk", "gabbis", "luan savio"…) criados quando
 * apelidos eram tratados como identidade. Destrutivo: só pelo `npm run data:sanitize` (com backup).
 */
export function pruneIdentityArtifactProfiles(runtime) {
  const longTerm = runtime?.longTerm;
  const profiles = longTerm?.data?.profiles;
  if (!profiles) return { removed: 0 };

  const nameTokens = new Set();
  for (const [key, profile] of Object.entries(profiles)) {
    if (!isIdentityIdLike(String(key).split("::")[0])) continue;
    const f = profile?.facts ?? {};
    for (const v of [f.displayName, f.name, f.preferredName, ...(f.nicknames ?? []), ...(f.tetoNicknames ?? []), ...(f.identityAliases ?? [])]) {
      const c = String(v ?? "").trim().toLowerCase();
      if (c) nameTokens.add(c);
    }
  }
  const isArtifact = (base) => {
    const lower = base.toLowerCase();
    if (isIdentityIdLike(base) || ["default", "teto", "self", "local"].includes(lower)) return false;
    if (/^\d+:\d+$/.test(base) || lower.startsWith("ui-")) return false; // grupo:participante / UI
    return nameTokens.has(lower) || !isPlausibleHumanNickname(base) || isWhatsAppGroupIdAlias(base);
  };

  let removed = 0;
  for (const [key, profile] of Object.entries(profiles)) {
    const base = String(key).split("::")[0];
    // Perfil real é escrito pelo pipeline (tem contagem de conversa); artefato de alias só tem fatos copiados.
    const neverTalked = !(Number(profile?.counts?.total) > 0);
    const keep = isIdentityIdLike(base) || ["default", "teto", "self", "local"].includes(base.toLowerCase()) || /^\d+:\d+$/.test(base);
    if (isArtifact(base) || (!keep && neverTalked) || base.startsWith("eval-")) {
      delete profiles[key];
      removed += 1;
    }
  }
  for (const key of Object.keys(longTerm.data.mediumTerm ?? {})) {
    const base = String(key).split("::")[0];
    if (!isIdentityIdLike(base) && isArtifact(base) && !String(key).includes(":")) {
      delete longTerm.data.mediumTerm[key];
    }
  }
  if (removed > 0) longTerm.persist?.();
  return { removed };
}

/** @deprecated use repairProfileContamination */
export function repairBotProfileContamination(runtime) {
  return repairProfileContamination(runtime);
}
