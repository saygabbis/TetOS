import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const ALLOWED_EXT = /\.(md|txt|json)$/i;

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
      .filter((name) => ALLOWED_EXT.test(name))
      .map((name) => ({
        id: basename(name),
        path: join(this.basePath, name)
      }));
  }

  /**
   * Nome seguro dentro da pasta de documentos: só o nome-base (nada de "../"), extensão permitida.
   * Para leitura, acha o arquivo existente ignorando caixa e extensão ("README" → "README.txt").
   */
  resolveId(id, { forWrite = false } = {}) {
    const name = basename(String(id ?? "").trim()).replace(/[^\p{L}\p{N}._ -]/gu, "");
    if (!name || name.startsWith(".")) return null;
    const lower = name.toLowerCase();
    const existing = this.list().find(
      (doc) => doc.id.toLowerCase() === lower || doc.id.toLowerCase().replace(/\.(md|txt|json)$/, "") === lower
    );
    if (existing) return existing.id;
    if (!forWrite) return null;
    return ALLOWED_EXT.test(name) ? name : `${name}.md`;
  }

  read(id) {
    const safeId = this.resolveId(id);
    if (!safeId) return null;
    const path = join(this.basePath, safeId);
    if (!existsSync(path)) return null;
    return {
      id: safeId,
      path,
      content: readFileSync(path, "utf-8")
    };
  }

  write(id, content) {
    ensureDir(this.basePath);
    const safeId = this.resolveId(id, { forWrite: true });
    if (!safeId) throw new Error("nome de documento inválido");
    id = safeId;
    const path = join(this.basePath, id);
    writeFileSync(path, String(content ?? ""), "utf-8");
    return {
      id,
      path,
      content: String(content ?? "")
    };
  }
}
