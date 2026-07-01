import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_DATA = {
  users: {},
  meta: { lastUpdated: null }
};

function userAliases(userId = "") {
  const id = String(userId ?? "").trim();
  if (!id) return [];
  const aliases = new Set([id]);
  if (id.startsWith("dm-")) aliases.add(id.slice(3));
  else if (/^\d+$/.test(id)) aliases.add(`dm-${id}`);
  return [...aliases];
}

export class StickerRepertoireModeStore {
  constructor(path) {
    this.path = path;
    this.data = readJson(path, DEFAULT_DATA) ?? structuredClone(DEFAULT_DATA);
    this.data.users ??= {};
    this.data.meta ??= {};
  }

  save() {
    this.data.meta.lastUpdated = new Date().toISOString();
    writeJson(this.path, this.data);
  }

  enable(userId, meta = {}) {
    const id = String(userId ?? "").trim();
    if (!id) return null;
    const entry = {
      active: true,
      enabledAt: new Date().toISOString(),
      enabledBy: meta.enabledBy ?? id,
      lastChannelId: meta.channelId ?? null,
      ...meta
    };
    for (const alias of userAliases(id)) {
      this.data.users[alias] = { ...entry, aliasOf: id };
    }
    this.save();
    return this.data.users[id] ?? entry;
  }

  disable(userId) {
    const id = String(userId ?? "").trim();
    if (!id) return false;
    let changed = false;
    for (const alias of userAliases(id)) {
      if (!this.data.users[alias]) continue;
      this.data.users[alias] = {
        ...this.data.users[alias],
        active: false,
        disabledAt: new Date().toISOString()
      };
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  isActive(userId) {
    for (const alias of userAliases(userId)) {
      if (this.data.users[alias]?.active) return true;
    }
    return false;
  }

  statusLine(userId) {
    return this.isActive(userId)
      ? "modo repertório: ATIVO (figurinhas que você mandar/encaminhar são salvas automaticamente)"
      : "modo repertório: inativo — use modoRepertorio(\"on\") ou .repertorio on";
  }
}
