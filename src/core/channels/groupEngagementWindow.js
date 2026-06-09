/** Janela por usuário em grupo: após menção/resposta, segue conversando sem @ por ttlMs. */
export class GroupEngagementWindow {
  constructor({ ttlMs = 120000 } = {}) {
    this.ttlMs = Number(ttlMs) > 0 ? Number(ttlMs) : 120_000;
    this.byKey = new Map();
  }

  key(groupId, userId) {
    return `${String(groupId ?? "").trim()}::${String(userId ?? "").trim()}`;
  }

  touch(groupId, userId, now = Date.now()) {
    const k = this.key(groupId, userId);
    if (!groupId || !userId) return null;
    const row = { expiresAt: now + this.ttlMs, lastAt: now };
    this.byKey.set(k, row);
    return row;
  }

  isActive(groupId, userId, now = Date.now()) {
    const k = this.key(groupId, userId);
    const row = this.byKey.get(k);
    if (!row) return false;
    if (row.expiresAt <= now) {
      this.byKey.delete(k);
      return false;
    }
    return true;
  }

  remainingMs(groupId, userId, now = Date.now()) {
    const row = this.byKey.get(this.key(groupId, userId));
    if (!row || row.expiresAt <= now) return 0;
    return row.expiresAt - now;
  }
}
