/** IDs vinculados (ex.: LID do WhatsApp ↔ telefone em LEARNING_TARGET_USER_ID). */
export function linkedUserIds(runtime, userId) {
  const uid = String(userId ?? "").trim();
  if (!uid) return ["default"];
  const ids = new Set([uid]);
  const target = String(runtime?.defaults?.learningTargetUserId ?? "").trim();
  if (target && target !== uid) {
    const looksLikeLid = uid.length >= 14 || /@lid$/i.test(uid);
    const looksLikePhone = /^\d{10,13}$/.test(uid);
    if (looksLikeLid && looksLikePhone === false) ids.add(target);
    if (uid === target) {
      // perfil telefone — sem alias automático reverso
    }
  }
  return [...ids];
}

export function touchUserActivity(runtime, userId, { markMessage = true } = {}) {
  for (const id of linkedUserIds(runtime, userId)) {
    runtime.basicLoop?.touch?.(id);
    if (markMessage) {
      runtime.timeStore?.markMessage?.(id);
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
    const lastMsg = runtime.timeStore?.getLastMessage?.(id);
    if (lastMsg) {
      const t = new Date(lastMsg).getTime();
      if (Number.isFinite(t) && now - t < windowMs) return true;
    }
  }
  return false;
}

/** ID canônico para memória/fila — LID do dono vira telefone do LEARNING_TARGET. */
export function canonicalUserId(runtime, userId) {
  const uid = String(userId ?? "").trim();
  if (!uid) return "default";
  const target = String(runtime?.defaults?.learningTargetUserId ?? "").trim();
  if (target && uid !== target && uid.length >= 14 && !/^\d{10,13}$/.test(uid)) {
    return target;
  }
  return uid;
}

export function canonicalSessionId(runtime, userId) {
  return `wa-${canonicalUserId(runtime, userId)}`;
}

export function resolveNudgeRemoteJid(runtime, userId) {
  const profile = runtime.longTerm?.getProfile?.(userId);
  const stored = profile?.facts?.waRemoteJid;
  if (stored && String(stored).includes("@")) return stored;
  const uid = String(userId ?? "").trim();
  if (/@/.test(uid)) return uid;
  return `${uid}@s.whatsapp.net`;
}
