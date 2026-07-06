/** Janela por usuário em grupo + mute temporário (calar) que bloqueia até menção direta. */

const CHANNEL_SCOPE_ALIASES = new Set(["todos", "all", "grupo", "group", "canal", "channel"]);
const USER_SCOPE_ALIASES = new Set(["eu", "user", "usuario", "pessoa", "privado"]);

export function resolveSilenceScope(scope, { isGroup = true } = {}) {
  const raw = String(scope ?? "").trim().toLowerCase();
  if (!raw) return isGroup ? "channel" : "channel";
  if (CHANNEL_SCOPE_ALIASES.has(raw)) return "channel";
  if (USER_SCOPE_ALIASES.has(raw)) return "user";
  return isGroup ? "channel" : "channel";
}

export class GroupEngagementWindow {
  constructor({ ttlMs = 120000, muteMs = 60_000 } = {}) {
    this.ttlMs = Number(ttlMs) > 0 ? Number(ttlMs) : 120_000;
    this.muteMs = Number(muteMs) > 0 ? Number(muteMs) : 60_000;
    this.byKey = new Map();
    this.muteByKey = new Map();
  }

  key(groupId, userId) {
    return `${String(groupId ?? "").trim()}::${String(userId ?? "").trim()}`;
  }

  channelMuteKey(channelId) {
    return `channel::${String(channelId ?? "").trim()}`;
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

  clear(groupId, userId) {
    return this.byKey.delete(this.key(groupId, userId));
  }

  clearGroup(groupId) {
    const prefix = `${String(groupId ?? "").trim()}::`;
    if (!prefix || prefix === "::") return 0;
    let cleared = 0;
    for (const k of [...this.byKey.keys()]) {
      if (k.startsWith(prefix)) {
        this.byKey.delete(k);
        cleared += 1;
      }
    }
    return cleared;
  }

  /** Mute temporário: ignora menção/reply/janela até expirar. */
  mute(channelId, { userId = null, ttlMs = this.muteMs, now = Date.now() } = {}) {
    const ms = Number(ttlMs) > 0 ? Number(ttlMs) : this.muteMs;
    const expiresAt = now + ms;
    const cid = String(channelId ?? "").trim();
    if (!cid) return null;

    if (userId) {
      const k = this.key(cid, userId);
      this.muteByKey.set(k, { expiresAt, scope: "user" });
      this.clear(cid, userId);
      return { key: k, expiresAt, scope: "user" };
    }

    const k = this.channelMuteKey(cid);
    this.muteByKey.set(k, { expiresAt, scope: "channel" });
    this.clearGroup(cid);
    return { key: k, expiresAt, scope: "channel" };
  }

  muteFromAgent(channelId, userId, { scope = "channel", ttlMs, now = Date.now() } = {}) {
    const resolved = resolveSilenceScope(scope, { isGroup: String(channelId).endsWith("@g.us") });
    if (resolved === "user" && userId) {
      return this.mute(channelId, { userId, ttlMs, now });
    }
    return this.mute(channelId, { ttlMs, now });
  }

  isMuted(channelId, userId = null, now = Date.now()) {
    const cid = String(channelId ?? "").trim();
    if (!cid) return false;

    const channelRow = this.muteByKey.get(this.channelMuteKey(cid));
    if (channelRow) {
      if (channelRow.expiresAt <= now) {
        this.muteByKey.delete(this.channelMuteKey(cid));
      } else {
        return true;
      }
    }

    if (userId) {
      const userRow = this.muteByKey.get(this.key(cid, userId));
      if (!userRow) return false;
      if (userRow.expiresAt <= now) {
        this.muteByKey.delete(this.key(cid, userId));
        return false;
      }
      return true;
    }

    return false;
  }

  unmute(channelId, userId = null) {
    const cid = String(channelId ?? "").trim();
    let cleared = 0;
    if (this.muteByKey.delete(this.channelMuteKey(cid))) cleared += 1;
    if (userId && this.muteByKey.delete(this.key(cid, userId))) cleared += 1;
    return cleared;
  }
}
