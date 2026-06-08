import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_DATA = {
  dm: {},
  groups: {},
  meta: { lastUpdated: null }
};

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
    this.data.dm[id] = {
      active: true,
      activatedAt: new Date().toISOString(),
      activatedBy: meta.activatedBy ?? id,
      ...meta
    };
    this.save();
    return this.data.dm[id];
  }

  deactivateDm(userId) {
    const id = String(userId ?? "").trim();
    if (!id) return false;
    if (!this.data.dm[id]) return false;
    this.data.dm[id] = {
      ...this.data.dm[id],
      active: false,
      deactivatedAt: new Date().toISOString()
    };
    this.save();
    return true;
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
    const id = String(userId ?? "").trim();
    return Boolean(this.data.dm[id]?.active);
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
