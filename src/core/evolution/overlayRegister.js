/**
 * Carregado com `node --import` (o supervisor já faz isso): liga a camada de código da Teto antes do app.
 *  - TETOS_EVOLUTION_SAFE=1 → modo seguro: ignora tudo que ela mudou (o supervisor liga depois de quedas seguidas).
 *  - TETOS_EVOLUTION_STAGE=<id> → inclui uma mudança em teste (usado pelos testes da própria mudança).
 * Versões cujo original mudou no repo (deploy novo) saem do ar aqui mesmo.
 */
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { OverlayStore } from "./overlayStore.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const safe = process.env.TETOS_EVOLUTION_SAFE === "1";
const stageId = process.env.TETOS_EVOLUTION_STAGE || null;

if (!safe) {
  try {
    const store = new OverlayStore(root, { dir: process.env.TETOS_EVOLUTION_DIR || process.env.TETOS_EVOLUTION_PATH || "data/evolution" });
    // Processo de teste (verificador) só lê: quem atualiza o manifesto é a Teto no ar.
    const dropped = process.env.TETOS_EVOLUTION_READONLY === "1" ? [] : store.dropStale();
    if (dropped.length) {
      store.note(`deploy mudou ${dropped.map((d) => d.rel).join(", ")} — minhas versões desses arquivos saíram do ar`);
    }
    const map = store.loaderMap({ stageId });
    if (Object.keys(map).length) register("./overlayHooks.js", import.meta.url, { data: { map } });
  } catch (error) {
    // Camada quebrada nunca impede a Teto de subir: sobe com o código original.
    console.error("[evolução] camada de código ignorada:", error?.message ?? error);
  }
}
