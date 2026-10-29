/**
 * Processo isolado que roda UMA habilidade criada pela Teto. Sobe com `node --permission` (sem ler/
 * escrever arquivos além deste e da habilidade, sem abrir processos) e sem variáveis de ambiente
 * (nenhum segredo aqui dentro). As ferramentas (pesquisar, ler página, lembrar) são pedidas ao
 * processo da Teto por mensagem — quem executa é ela, com as regras dela.
 *
 * Protocolo: recebe { code, input, memory } → responde { ok, text?, memory?, error? }.
 */
import vm from "node:vm";

let seq = 0;
const waiting = new Map();

function callTool(name, args) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.send({ type: "tool", id, name, args });
  });
}

process.on("message", async (msg) => {
  if (msg?.type === "tool-result") {
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(String(msg.error)));
    else w.resolve(msg.value);
    return;
  }
  if (msg?.type !== "run") return;
  try {
    let def = null;
    const context = vm.createContext({
      habilidade: (d) => {
        def = d;
      }
    });
    new vm.Script(String(msg.code), { filename: "habilidade.js" }).runInContext(context, { timeout: 500 });
    if (!def || typeof def.rodar !== "function") throw new Error("habilidade sem rodar()");
    const memory = { ...(msg.memory ?? {}) };
    // Ferramentas criadas dentro do contexto da habilidade (nada do processo vaza pra lá).
    const bridge = new vm.Script(`({
      pesquisar: (q) => __call("pesquisar", [String(q)]),
      ler: (url) => __call("ler", [String(url)]),
      web: (url, opcoes) => __call("web", [String(url), opcoes ?? {}]),
      agora: () => new Date().toISOString(),
      lembrar: (k, v) => { if (v === undefined) return __mem[String(k)]; __mem[String(k)] = v; return v; }
    })`).runInContext(
      Object.assign(context, {
        __call: (name, args) => callTool(name, JSON.parse(JSON.stringify(args))).then((v) => JSON.parse(JSON.stringify(v ?? null))),
        __mem: memory
      })
    );
    const input = JSON.parse(JSON.stringify(msg.input ?? {}));
    const out = await def.rodar(input, bridge);
    process.send({ type: "done", ok: true, text: out == null ? "" : String(out).slice(0, 1500), memory: JSON.parse(JSON.stringify(memory)) });
  } catch (error) {
    process.send({ type: "done", ok: false, error: String(error?.message ?? error).slice(0, 300) });
  }
});
