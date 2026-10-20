// Isola testes que sobem o runtime completo: rodam num diretório temporário e nunca tocam o data/ de produção.
// Importe ANTES de tudo (`import "./isolatedData.js";`) — os caminhos ./data/* passam a apontar para o temporário.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const repo = fileURLToPath(new URL("..", import.meta.url));
dotenv.config({ path: join(repo, ".env"), quiet: true });

const dir = mkdtempSync(join(tmpdir(), "tetos-test-"));
mkdirSync(join(dir, "data"), { recursive: true });
// Persona/lore (somente leitura) para o runtime subir com a Teto de verdade.
for (const f of ["character.json", "personality.json", "tetoLife.json", "tetoDiscography.json", "stickers"]) {
  const src = join(repo, "data", f);
  if (existsSync(src)) cpSync(src, join(dir, "data", f), { recursive: true });
}
process.chdir(dir);
process.on("exit", () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});
