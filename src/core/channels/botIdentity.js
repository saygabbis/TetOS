import { dmUserId, normalizeJidKey, ownerIdentityIds } from "./userActivity.js";
import { extractLocalPart } from "./waIdentity.js";

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

  return [...new Set(aliases.map((a) => String(a ?? "").trim()).filter(Boolean))].filter((alias) => {
    const lower = alias.toLowerCase();
    if (isBot) {
      if (ownerIds.has(alias) || ownerIds.has(`dm-${alias}`)) return false;
      if (lower === "gabbis" || lower === "gabbi") return false;
    }
    if (!isBot && botIds.has(alias)) return false;
    if (isOwner && botIds.has(alias)) return false;
    return true;
  });
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

export function buildBotActorIds(runtime, botPhone = "") {
  const ids = new Set(["teto", "self"]);
  for (const id of botIdentityIds(runtime)) ids.add(id);
  const phone = String(botPhone ?? "").replace(/\D/g, "").trim();
  if (phone) {
    ids.add(phone);
    ids.add(`dm-${phone}`);
  }
  return ids;
}

/** Limpa aliases cruzados bot↔dona em perfis já salvos. */
export function repairBotProfileContamination(runtime) {
  const longTerm = runtime?.longTerm;
  if (!longTerm?.data?.profiles) return { repaired: 0 };

  let repaired = 0;
  for (const [profileKey, profile] of Object.entries(longTerm.data.profiles)) {
    const facts = profile?.facts ?? {};
    const aliases = facts.identityAliases ?? [];
    if (!aliases.length) continue;

    const cleaned = sanitizeIdentityAliases(aliases, runtime, profileKey);
    if (cleaned.length === aliases.length) continue;

    longTerm.updateProfile(profileKey, {
      facts: { ...facts, identityAliases: cleaned }
    });
    repaired += 1;
  }
  return { repaired };
}
