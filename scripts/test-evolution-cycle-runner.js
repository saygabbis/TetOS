// "Runner" de mentira pro teste do ciclo de evolução (scripts/test-evolution-cycle.js). Roda debaixo do
// supervisor de verdade, com a camada de código de verdade. Cada subida é uma fase:
//  1. aprova uma mudança boa e pede reinício           → supervisor religa (reinício planejado)
//  2. confere que a versão dela carregou; aprova uma mudança que quebra na subida e reinicia
//  3/4. cai na subida (a mudança ruim)                  → supervisor liga o modo seguro
//  5. modo seguro: desfaz a última mudança e reinicia
//  6. confere que voltou com a mudança boa e sem a ruim
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OverlayStore } from "../src/core/evolution/overlayStore.js";
import { EvolutionEngine } from "../src/core/evolution/evolutionEngine.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = process.env.TETOS_EVOLUTION_PATH;
const statePath = join(dir, "cycle-state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { boot: 0, log: [] };
state.boot += 1;
state.pid = process.pid;
const note = (text) => {
  state.log.push(`${state.boot}: ${text}`);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
};
note(`subiu${process.env.TETOS_EVOLUTION_SAFE === "1" ? " em modo seguro" : ""}`);

const rel = "src/modules/chat/bubbleComposer.js";
const moduleUrl = pathToFileURL(join(root, rel)).href;
const store = new OverlayStore(root, { dir });
const engine = new EvolutionEngine({
  root,
  dir,
  store,
  verifier: { verify: async () => ({ ok: true, stage: "ok", details: "teste do ciclo" }) },
  skills: { list: () => [] },
  llm: null,
  notifyOwner: async (text) => note(`aviso pra dona: ${text.split("\n")[0]}`),
  supervised: process.env.TETOS_SUPERVISED === "1"
});
const approve = (id, content) => {
  store.stage(id, { [rel]: content }, { reason: `mudança ${id}` });
  store.setStatus(id, "aprovado");
};

if (process.env.TETOS_EVOLUTION_SAFE === "1") {
  await engine.onBoot();
  note("modo seguro: desfiz a última mudança");
} else {
  const mod = await import(moduleUrl); // na fase 3/4 isto quebra (mudança ruim no ar)
  const original = readFileSync(join(root, rel), "utf8");
  if (state.boot === 1) {
    approve("boa", `${original}\nexport const CICLO_MARCA = "boa";\n`);
    note(`aplicando a boa: ${engine.maybeApply({ force: true })}`);
  } else if (state.boot === 2) {
    note(`marca=${mod.CICLO_MARCA}`);
    approve("ruim", `throw new Error("quebrei de propósito");\n${store.currentContent(rel)}`);
    note(`aplicando a ruim: ${engine.maybeApply({ force: true })}`);
  } else {
    note(`marca=${mod.CICLO_MARCA} boa=${store.change("boa")?.status} ruim=${store.change("ruim")?.status}`);
    state.done = true;
    note("fim");
  }
}
setInterval(() => {}, 60_000); // fica vivo até o supervisor/teste encerrar
