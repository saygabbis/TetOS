import { linkedIdentityIds } from "./waIdentity.js";

/** Normaliza JID/LID para comparação estável (sem sufixo de dispositivo). */
export function normalizeJidKey(jid = "") {
  return String(jid ?? "").split(":")[0].toLowerCase().trim();
}

/** ID estável por contato em DM — todos iguais, inclusive a dona. */
export function dmUserId(remoteJid, baseUserId = "") {
  const key = normalizeJidKey(remoteJid);
  if (!key) return `dm-${String(baseUserId ?? "unknown").trim() || "unknown"}`;
  const local = key.replace(/@.+$/, "");
  return `dm-${local}`;
}

/** IDs que identificam a dona (admin/aprendizado) — não colapsam memória de chat. */
export function ownerIdentityIds(runtime) {
  const ids = new Set();
  const phone = String(runtime?.defaults?.learningTargetUserId ?? "").trim();
  if (phone) ids.add(phone);

  for (const jid of runtime?.defaults?.ownerWaJids ?? []) {
    const key = normalizeJidKey(jid);
    if (!key) continue;
    ids.add(dmUserId(jid));
    const local = key.replace(/@.+$/, "");
    if (local) ids.add(local);
  }

  return ids;
}

/** Dona do bot — só para permissão e contexto, não para perfil/memória compartilhada. */
export function isOwnerContact(runtime, remoteJid = null, userId = "") {
  const ids = ownerIdentityIds(runtime);
  if (!ids.size) return false;

  const uid = String(userId ?? "").trim();
  if (uid && ids.has(uid)) return true;

  if (remoteJid) {
    const dm = dmUserId(remoteJid);
    if (ids.has(dm)) return true;
  }

  return false;
}

/** ID do ator humano dono (mensagens fromMe na sessão de observação). */
export function resolveOwnerActorId(runtime) {
  const jids = runtime?.defaults?.ownerWaJids ?? [];
  if (jids[0]) return dmUserId(jids[0]);
  const phone = String(runtime?.defaults?.learningTargetUserId ?? "").trim();
  return phone || null;
}

/** Mesmo contato pode aparecer como tel, LID ou dm-* — unifica para memória/atividade. */
export function linkedUserIds(runtime, userId) {
  return linkedIdentityIds(runtime, userId);
}

export function touchUserActivity(runtime, userId, { markMessage = true, sessionId = null } = {}) {
  for (const id of linkedUserIds(runtime, userId)) {
    runtime.basicLoop?.touch?.(id);
    if (markMessage) {
      runtime.initiationEngine?.cancelForUser?.(id);
      runtime.timeStore?.markMessage?.(id, Date.now(), sessionId);
    }
    runtime.userPatterns?.recordInteraction?.(id);
  }
}

export function isUserRecentlyActive(runtime, userId, inactiveMs) {
  const windowMs = Number(inactiveMs) > 0 ? Number(inactiveMs) : 600000;
  const now = Date.now();
  for (const id of linkedUserIds(runtime, userId)) {
    const lastTouch = runtime.basicLoop?.lastInteractionAt?.get?.(id) ?? 0;
    if (now - lastTouch < windowMs) return true;
    const lastMsg =
      runtime.timeStore?.getLastUserMessage?.(id, null) ??
      runtime.timeStore?.getLastMessage?.(id, null);
    if (lastMsg) {
      const t = new Date(lastMsg).getTime();
      if (Number.isFinite(t) && now - t < windowMs) return true;
    }
  }
  return false;
}

/** Memória/fila — um PV = um userId (dona inclusa, sem telefone canônico). */
export function canonicalUserId(_runtime, userId, { remoteJid = null } = {}) {
  const uid = String(userId ?? "").trim();
  if (!uid) return "default";

  const isGroup = remoteJid && String(remoteJid).endsWith("@g.us");
  if (!isGroup && remoteJid) {
    return dmUserId(remoteJid, uid);
  }

  return uid;
}

/** Sessão de chat — um PV = uma sessão isolada (persiste após restart). */
export function canonicalSessionId(_runtime, userId, { remoteJid = null } = {}) {
  if (remoteJid && !String(remoteJid).endsWith("@g.us")) {
    return `wa-dm:${normalizeJidKey(remoteJid)}`;
  }
  return `wa-${canonicalUserId(null, userId, { remoteJid })}`;
}

export function resolveNudgeRemoteJid(_runtime, userId) {
  const uid = String(userId ?? "").trim();
  if (uid.startsWith("dm-")) {
    return `${uid.slice(3)}@lid`;
  }
  if (/@/.test(uid)) return uid;
  return `${uid}@s.whatsapp.net`;
}
