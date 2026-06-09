/** Chaves para lastMessageAt — sessão primeiro, depois legado (telefone/LID). */
export function resolveTimeLookupKeys(userId = "", sessionId = "") {
  const keys = [];
  const sid = String(sessionId ?? "").trim();
  const uid = String(userId ?? "").trim();

  if (sid) keys.push(sid);

  if (uid) keys.push(uid);

  const dm = uid.match(/^dm-(.+)$/i);
  if (dm?.[1]) keys.push(dm[1]);

  const waDm = sid.match(/^wa-dm:(.+)$/i);
  if (waDm?.[1]) {
    const local = waDm[1].split(":")[0].replace(/@.+$/i, "");
    if (local) keys.push(local);
  }

  return [...new Set(keys.filter(Boolean))];
}

/** Onde gravar o timestamp — prefere sessão do chat. */
export function resolveTimeWriteKey(userId = "", sessionId = "") {
  const sid = String(sessionId ?? "").trim();
  if (sid) return sid;
  const uid = String(userId ?? "").trim();
  return uid || "default";
}
