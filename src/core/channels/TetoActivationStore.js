import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_DATA = {
  dm: {},
  groups: {},
  meta: { lastUpdated: null }
};

function dmAliasIds(userId = "") {
  const id = String(userId ?? "").trim();
  if (!id) return [];
  const aliases = new Set([id]);
  if (id.startsWith("dm-")) {
    aliases.add(id.slice(3));
  } else if (/^\d+$/.test(id)) {
    aliases.add(`dm-${id}`);
  }
  return [...aliases];
}

export class TetoActivationStore {
  constructor(path, { activationRequired = false } = {}) {
    this.path = path;
    this.activationRequired = activationRequired;
    this.data = readJson(path, DEFAULT_DATA) ?? structuredClone(DEFAULT_DATA);
    this.data.dm ??= {};
    this.data.groups ??= {};
    this.data.meta ??= {};
  }

  save() {
    this.data.meta.lastUpdated = new Date().toISOString();
    writeJson(this.path, this.data);
  }

  isActivationRequired() {
    return this.activationRequired;
  }

  activateDm(userId, meta = {}) {
    const id = String(userId ?? "").trim();
    if (!id) return null;
    const entry = {
      active: true,
      activatedAt: new Date().toISOString(),
      activatedBy: meta.activatedBy ?? id,
      ...meta
    };
    for (const alias of dmAliasIds(id)) {
      this.data.dm[alias] = { ...entry, aliasOf: id };
    }
    this.save();
    return this.data.dm[id] ?? entry;
  }

  deactivateDm(userId) {
    const id = String(userId ?? "").trim();
    if (!id) return false;
    let changed = false;
    for (const alias of dmAliasIds(id)) {
      if (!this.data.dm[alias]) continue;
      this.data.dm[alias] = {
        ...this.data.dm[alias],
        active: false,
        deactivatedAt: new Date().toISOString()
      };
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  activateGroup(channelId, meta = {}) {
    const id = String(channelId ?? "").trim();
    if (!id) return null;
    this.data.groups[id] = {
      active: true,
      activatedAt: new Date().toISOString(),
      activatedBy: meta.activatedBy ?? "unknown",
      ...meta
    };
    this.save();
    return this.data.groups[id];
  }

  deactivateGroup(channelId) {
    const id = String(channelId ?? "").trim();
    if (!id) return false;
    if (!this.data.groups[id]) return false;
    this.data.groups[id] = {
      ...this.data.groups[id],
      active: false,
      deactivatedAt: new Date().toISOString()
    };
    this.save();
    return true;
  }

  isDmActive(userId) {
    if (!this.activationRequired) return true;
    for (const alias of dmAliasIds(userId)) {
      if (this.data.dm[alias]?.active) return true;
    }
    return false;
  }

  isGroupActive(channelId) {
    if (!this.activationRequired) return true;
    const id = String(channelId ?? "").trim();
    return Boolean(this.data.groups[id]?.active);
  }

  /** Registra contato para migração futura quando activationRequired=false. */
  touchDm(userId) {
    if (this.activationRequired) return;
    const id = String(userId ?? "").trim();
    if (!id) return;
    if (!this.data.dm[id]) {
      this.data.dm[id] = {
        active: true,
        autoAdded: true,
        activatedAt: new Date().toISOString()
      };
      this.save();
    }
  }

  listActive() {
    return {
      dm: Object.entries(this.data.dm)
        .filter(([, v]) => v.active)
        .map(([id]) => id),
      groups: Object.entries(this.data.groups)
        .filter(([, v]) => v.active)
        .map(([id]) => id)
    };
  }
}
