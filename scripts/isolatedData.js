// Isola testes que sobem o runtime completo: rodam num diretório temporário e nunca tocam o data/ de produção.
// Importe ANTES de tudo (`import "./isolatedData.js";`) — os caminhos ./data/* passam a apontar para o temporário.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { flushJsonWrites } from "../src/infra/utils/fileStore.js";

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
  // Grava o que ficou pendente ANTES de apagar a pasta: no Linux, gravar depois (com o diretório atual
  // apagado) deixava o mkdirSync recursivo num laço infinito a 100% de CPU, imune a SIGTERM.
  try { flushJsonWrites(); } catch {}
  try { process.chdir(tmpdir()); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});
