import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export class DocumentStore {
  constructor(basePath = "./data/documents") {
    this.basePath = basePath;
    ensureDir(this.basePath);
  }

  list() {
    ensureDir(this.basePath);
    return readdirSync(this.basePath)
      .filter((name) => name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".json"))
      .map((name) => ({
        id: basename(name),
        path: join(this.basePath, name)
      }));
  }

  read(id) {
    const path = join(this.basePath, id);
    if (!existsSync(path)) return null;
    return {
      id,
      path,
      content: readFileSync(path, "utf-8")
    };
  }

  write(id, content) {
    ensureDir(this.basePath);
    const path = join(this.basePath, id);
    writeFileSync(path, String(content ?? ""), "utf-8");
    return {
      id,
      path,
      content: String(content ?? "")
    };
  }
}
