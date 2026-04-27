import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = {
  focus: "general",
  notes: "",
  updatedAt: null
};

export class FocusConfigStore {
  constructor(path) {
    this.path = path;
    this.state = readJson(path, DEFAULT_STATE) ?? { ...DEFAULT_STATE };
  }

  get() {
    return this.state;
  }

  setFocus(focus, notes = "") {
    this.state = {
      focus: String(focus ?? "general").trim() || "general",
      notes: String(notes ?? "").trim(),
      updatedAt: new Date().toISOString()
    };
    writeJson(this.path, this.state);
    return this.state;
  }

  reset() {
    this.state = { ...DEFAULT_STATE, updatedAt: new Date().toISOString() };
    writeJson(this.path, this.state);
    return this.state;
  }
}
