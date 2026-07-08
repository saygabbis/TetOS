import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_DATA = {
  enabled: false,
  enabledAt: null,
  enabledBy: null,
  meta: { lastUpdated: null }
};

export class ViewOnceMirrorStore {
  constructor(path = "./data/viewOnceMirror.json") {
    this.path = path;
    this.data = readJson(path, DEFAULT_DATA) ?? structuredClone(DEFAULT_DATA);
  }

  save() {
    this.data.meta ??= {};
    this.data.meta.lastUpdated = new Date().toISOString();
    writeJson(this.path, this.data);
  }

  isEnabled() {
    return Boolean(this.data.enabled);
  }

  enable(adminUserId = null) {
    this.data.enabled = true;
    this.data.enabledAt = new Date().toISOString();
    this.data.enabledBy = adminUserId ?? null;
    this.save();
    return this.data;
  }

  disable() {
    this.data.enabled = false;
    this.data.disabledAt = new Date().toISOString();
    this.save();
    return this.data;
  }

  statusLine() {
    return this.isEnabled()
      ? "view única espelhada: ATIVO — mídias de visualização única serão reenviadas no seu PV como mídia normal"
      : "view única espelhada: inativo — use .viewunica on para ativar";
  }
}
