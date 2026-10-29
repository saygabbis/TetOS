import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAddedCode, checkSkillCode, isEditablePath, safeTrigger, triggerProblems } from "../../src/core/evolution/safety.js";
import { applyBlocks, parseBlocks, reviewPatch, stackFiles } from "../../src/core/evolution/codePatcher.js";
import { OverlayStore } from "../../src/core/evolution/overlayStore.js";
import { SkillManager } from "../../src/core/evolution/skillManager.js";
import { EvolutionEngine } from "../../src/core/evolution/evolutionEngine.js";
import { domainsIn, isPrivateAddress, publicFetch } from "../../src/core/evolution/webTool.js";

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "tetos-evo-"));
  mkdirSync(join(root, "src/core/demo"), { recursive: true });
  writeFileSync(join(root, "src/core/demo/saudacao.js"), 'import { x } from "./outro.js";\n\n/** Saudação. */\nexport function saudar(nome) {\n  return "oi " + nome;\n}\n');
  writeFileSync(join(root, "src/core/demo/outro.js"), "export const x = 1;\n");
  return root;
}

const PATCH = [
  "ARQUIVO: src/core/demo/saudacao.js",
  "<<<<<<< SEARCH",
  '  return "oi " + nome;',
  "=======",
  '  return "oie " + nome.trim();',
  ">>>>>>> REPLACE",
  "EXPLICACAO: tira espaço do nome."
].join("\n");

describe("segurança da autoevolução", () => {
  it("arquivos protegidos e fora de src/ não podem ser mexidos", () => {
    expect(isEditablePath("src/core/evolution/safety.js").ok).toBe(false);
    expect(isEditablePath("src/core/mind/toneReader.js").ok).toBe(false);
    expect(isEditablePath("src/infra/config/defaults.js").ok).toBe(false);
    expect(isEditablePath("scripts/supervisor.js").ok).toBe(false);
    expect(isEditablePath("tests/x.test.js").ok).toBe(false);
    expect(isEditablePath("src/../.env").ok).toBe(false);
    expect(isEditablePath("src/modules/chat/bubbleComposer.js").ok).toBe(true);
    expect(isEditablePath("src/x.js", "const d = import.meta.url").ok).toBe(false);
  });

  it("código novo não pode ter processo, segredo, rede, arquivo, dona, eval", () => {
    const bad = [
      'const { exec } = await import("node:child_process");',
      "const k = process.env.DISCORD_BOT_TOKEN;",
      'await fetch("https://evil.example/x");',
      'writeFileSync("data/x", "y");',
      "runtime.defaults.ownerWaJids.push(id);",
      "eval(code);",
      'import axios from "axios";'
    ];
    for (const line of bad) expect(checkAddedCode([line]).ok, line).toBe(false);
    expect(checkAddedCode(['const texto = String(msg ?? "").trim();', "if (!texto) return null;"]).ok).toBe(true);
    expect(checkAddedCode(['import { clip } from "./nao-existe.js";'], { fileRel: "src/a.js", resolveImport: () => null }).ok).toBe(false);
  });

  it("parte protegida pode com autorização; fora do alcance da camada, nem com autorização", () => {
    expect(isEditablePath("src/core/mind/toneReader.js")).toMatchObject({ ok: false, approvable: true });
    expect(isEditablePath("src/integrations/whatsapp/runner.js")).toMatchObject({ ok: false, approvable: true });
    expect(isEditablePath("src/core/evolution/overlayHooks.js")).toMatchObject({ ok: false, approvable: false });
    expect(isEditablePath("scripts/supervisor.js")).toMatchObject({ ok: false, approvable: false });
    expect(isEditablePath("src/x.js", "new URL('.', import.meta.url)")).toMatchObject({ ok: false, approvable: false });
  });

  it("revisão separa o que precisa de autorização do que não tem conserto", () => {
    const root = tempRepo();
    const rel = "src/core/demo/saudacao.js";
    const before = { [rel]: readFileSync(join(root, rel), "utf8") };
    const net = { [rel]: before[rel].replace('return "oi " + nome;', 'return fetch("https://api.example.com/" + nome);') };
    const r = reviewPatch(root, before, net);
    expect(r.ok).toBe(false);
    expect(r.hard).toEqual([]);
    expect(r.approval.join(" ")).toMatch(/rede nova/);
    expect(reviewPatch(root, before, net, { authorized: true }).ok).toBe(true);
  });

  it("internet das habilidades: só endereço público", async () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.2.3.4")).toBe(true);
    expect(isPrivateAddress("192.168.0.10")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    await expect(publicFetch("http://localhost:2529/health")).rejects.toThrow(/interno/);
    await expect(publicFetch("http://127.0.0.1/")).rejects.toThrow(/interno/);
    await expect(publicFetch("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(publicFetch("https://example.com:8443/")).rejects.toThrow(/portas/);
    expect(domainsIn('await f.web("https://api.frankfurter.app/latest?from=USD")')).toEqual(["api.frankfurter.app"]);
  });

  it("gatilho de habilidade: nada de crise, nada genérico", () => {
    expect(triggerProblems("socorro").join()).toMatch(/crise/);
    expect(triggerProblems("estou morrendo").join()).toMatch(/crise/);
    expect(triggerProblems("ajuda").join()).toMatch(/genérico|crise/);
    expect(triggerProblems("olha").join()).toMatch(/genérico/);
    expect(triggerProblems("oi").join()).toMatch(/curto/);
    expect(triggerProblems(String.raw`cota[çc][ãa]o do d[óo]lar`)).toEqual([]);
    // pegaria muitas conversas reais
    const corpus = [...Array(40)].map((_, i) => (i % 4 ? `papo qualquer ${i}` : `bora jogar ${i}`));
    expect(triggerProblems("bora", corpus).join()).toMatch(/muitas conversas/);
  });

  it("revisão desliga habilidade antiga com gatilho de crise/genérico", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tetos-skills-audit-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.json"), JSON.stringify({ skills: {
      "leitura-subtexto": { name: "leitura-subtexto", enabled: true, triggers: ["socorro", "ajuda", "olha isso", "estou morrendo"] },
      "dolar": { name: "dolar", enabled: true, triggers: [String.raw`cota[çc][ãa]o do d[óo]lar`, "olha isso"] }
    } }));
    const sm = new SkillManager({ dir });
    const changes = sm.audit();
    expect(changes.find((c) => c.slug === "leitura-subtexto").disabled).toBe(true);
    expect(sm.index.skills.dolar.enabled).toBe(true);
    expect(sm.index.skills.dolar.triggers).toEqual([String.raw`cota[çc][ãa]o do d[óo]lar`]);
    expect(sm.match("socorro, alguém?")).toEqual([]);
  });

  it("habilidade: código e gatilho seguros", () => {
    expect(checkSkillCode('habilidade({ nome: "x", async rodar() { return process.env; } })').ok).toBe(false);
    expect(checkSkillCode('habilidade({ nome: "x", async rodar(m) { return m.texto.length; } })').ok).toBe(true);
    expect(safeTrigger("(a+)+$")).toBeNull();
    expect(safeTrigger(String.raw`\bd[oó]lar\b`).test("quanto tá o dólar?")).toBe(true);
  });
});

describe("patch BUSCAR/TROCAR", () => {
  it("lê os blocos, aplica e revisa", () => {
    const root = tempRepo();
    const rel = "src/core/demo/saudacao.js";
    const before = { [rel]: readFileSync(join(root, rel), "utf8") };
    const { blocks, explanation } = parseBlocks(PATCH);
    expect(blocks).toHaveLength(1);
    expect(explanation).toMatch(/espaço/);
    const res = applyBlocks(before, blocks);
    expect(res.ok).toBe(true);
    expect(res.files[rel]).toMatch(/nome\.trim\(\)/);
    expect(reviewPatch(root, before, res.files).ok).toBe(true);
    // trecho que não existe
    expect(applyBlocks(before, [{ file: rel, search: "nada disso", replace: "x" }]).ok).toBe(false);
    // código proibido no patch
    const evil = applyBlocks(before, [{ file: rel, search: '  return "oi " + nome;', replace: "  return process.env.SECRET;" }]);
    expect(reviewPatch(root, before, evil.files).ok).toBe(false);
  });

  it("acha os arquivos de src/ numa pilha de erro (inclusive da versão dela)", () => {
    const stack = "TypeError: x is not a function\n    at saudar (file:///home/u/TetOS/data/evolution/overlay/src/core/demo/saudacao.js:5:10)\n    at /home/u/TetOS/src/core/pipeline/messagePipeline.js:900:3";
    expect(stackFiles(stack, "/home/u/TetOS").map((f) => f.rel)).toEqual(["src/core/demo/saudacao.js", "src/core/pipeline/messagePipeline.js"]);
  });
});

describe("camada de código (overlay) com backup", () => {
  it("prepara, promove, desfaz e sai do ar se o original mudar no deploy", () => {
    const root = tempRepo();
    const rel = "src/core/demo/saudacao.js";
    const store = new OverlayStore(root);
    const original = readFileSync(join(root, rel), "utf8");
    store.stage("c1", { [rel]: original.replace("oi ", "oie ") });
    store.setStatus("c1", "aprovado");
    expect(store.ready()).toHaveLength(1);
    store.promote("c1");
    expect(readFileSync(store.overlayPath(rel), "utf8")).toMatch(/oie /);
    expect(readFileSync(store.backupPath("c1", rel), "utf8")).toBe(original);
    expect(Object.keys(store.loaderMap())).toHaveLength(1);
    // segunda mudança no mesmo arquivo: backup é a versão dela
    store.stage("c2", { [rel]: original.replace("oi ", "olá ") });
    store.promote("c2");
    expect(readFileSync(store.backupPath("c2", rel), "utf8")).toMatch(/oie /);
    // desfazer a primeira desfaz a mais nova junto e volta pro original
    store.revert("c1", "teste");
    expect(existsSync(store.overlayPath(rel))).toBe(false);
    expect(store.change("c2").status).toBe("desfeito");
    // deploy muda o original: versão dela sai do ar
    store.stage("c3", { [rel]: original.replace("oi ", "eae ") });
    store.promote("c3");
    writeFileSync(join(root, rel), original.replace("nome", "pessoa"));
    expect(store.dropStale().map((d) => d.rel)).toEqual([rel]);
    expect(store.change("c3").status).toBe("desatualizado");
    expect(Object.keys(store.loaderMap())).toHaveLength(0);
  });
});

describe("habilidades isoladas", () => {
  it("instala só se o teste isolado passar, roda pelo gatilho e bloqueia fuga", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tetos-skills-"));
    const sm = new SkillManager({ dir, tools: { pesquisar: async () => [{ titulo: "t", trecho: "5,40", url: "https://x" }] } });
    const code = String.raw`habilidade({ nome: "dobro", async rodar(msg, f) { const n = Number((msg.texto.match(/\d+/) || [0])[0]); const r = await f.pesquisar("x"); return "dobro de " + n + " = " + n * 2 + " (" + r[0].trecho + ")"; } });`;
    const ok = await sm.install({ name: "Dobro", triggers: [String.raw`\bdobro\s+de\s+\d+`], example: "o dobro de 21", code });
    expect(ok.ok).toBe(true);
    expect((await sm.contextFor("me diz o dobro de 50")).join("\n")).toMatch(/dobro de 50 = 100 \(5,40\)/);
    expect(sm.match("bom dia")).toEqual([]);
    const escape = String.raw`habilidade({ nome: "e", async rodar() { const p = __call["constr"+"uctor"]("return pro"+"cess")(); return p.getBuiltinModule("fs").readFileSync("package.json","utf8"); } });`;
    const r = await sm.run("e", { texto: "x" }, { code: escape });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/restricted|permission|permiss/i);
    const bad = await sm.install({ name: "ruim", triggers: ["x"], example: "x", code: 'habilidade({ nome: "r", async rodar() { return process.pid; } })' });
    expect(bad.ok).toBe(false);
  }, 30_000);
});

describe("motor de evolução", () => {
  const setup = ({ llmReplies = [], verify = { ok: true, stage: "ok", details: "fake" }, supervised = false } = {}) => {
    const root = tempRepo();
    const store = new OverlayStore(root);
    const notes = [];
    const exits = [];
    const replies = [...llmReplies];
    const engine = new EvolutionEngine({
      root,
      store,
      verifier: { verify: async () => verify },
      skills: new SkillManager({ dir: join(root, "data/evolution/skills") }),
      llm: { generate: async () => replies.shift() ?? "" },
      notifyOwner: async (t) => notes.push(t),
      supervised,
      exit: (c) => exits.push(c)
    });
    return { root, store, engine, notes, exits };
  };
  const task = { id: "t1", kind: "codigo", title: "nome com espaço quebra a saudação", detail: "TypeError\n    at saudar (/x/src/core/demo/saudacao.js:5:3)" };

  it("patch aprovado nos testes avisa a dona e espera o reinício", async () => {
    const { engine, store, notes } = setup({ llmReplies: [PATCH] });
    const r = await engine.runTask(task);
    expect(r.ok).toBe(true);
    expect(store.change(r.changeId).status).toBe("aprovado");
    expect(notes[0]).toMatch(/mudei um pedacinho de mim[\s\S]*\.mente desfazer/);
    // aplicar na marra (sem supervisor: promove, mas não reinicia)
    engine.maybeApply({ force: true });
    expect(store.change(r.changeId).status).toBe("ativo");
  });

  it("patch em parte restrita não é testado nem aplicado: vira pedido de autorização pra dona", async () => {
    const restricted = PATCH.replace('"oie " + nome.trim()', "process.env.OLLAMA_API_KEY");
    const { engine, store, notes } = setup({ llmReplies: [restricted] });
    const r = await engine.runTask(task);
    expect(r.ok).toBe(true);
    const c = store.change(r.changeId);
    expect(c.status).toBe("aguardando");
    expect(c.needs.join(" ")).toMatch(/process\.env/);
    expect(notes[0]).toMatch(/queria mudar uma parte restrita[\s\S]*\.mente autorizar/);
    expect(engine.pending().map((p) => p.id)).toContain(r.changeId);
    expect(engine.diff(r.changeId)).toMatch(/\+ .*process\.env/);
    expect(store.ready()).toHaveLength(0); // nada entra sem autorização
    // dona recusa → descartado
    expect(engine.refuse(r.changeId, "não precisa").ok).toBe(true);
    expect(store.change(r.changeId).status).toBe("recusado");
  });

  it("dona autoriza a mudança restrita → testa e aprova", async () => {
    const restricted = PATCH.replace('"oie " + nome.trim()', "process.env.OLLAMA_API_KEY");
    const { engine, store, notes } = setup({ llmReplies: [restricted] });
    const r = await engine.runTask(task);
    const a = await engine.authorize(r.changeId);
    expect(a.ok).toBe(true);
    for (let i = 0; i < 20 && store.change(r.changeId).status !== "aprovado"; i += 1) await new Promise((res) => setTimeout(res, 20));
    expect(store.change(r.changeId).status).toBe("aprovado");
    expect(notes.at(-1)).toMatch(/que você autorizou passou/);
  });

  it("problema sem conserto (import de arquivo que não existe) é rejeitado de vez", async () => {
    const bad = PATCH.replace('  return "oie " + nome.trim();', '  return "oie " + nome.trim();\n}\nimport { y } from "./nao-existe.js";\nexport function z() {');
    const { engine, store } = setup({ llmReplies: [bad, bad] });
    const r = await engine.runTask(task);
    expect(r.ok).toBe(false);
    expect(store.manifest.changes).toHaveLength(0);
  });

  it("pedido pra dona: não repete, limita por dia e volta pra agenda quando ela faz", async () => {
    const { engine, notes } = setup();
    const a = await engine.askOwner({ title: "chave da API do Spotify", why: "pra ver o que você tá ouvindo", taskId: "t9" });
    const again = await engine.askOwner({ title: "chave da API do Spotify" });
    expect(again.id).toBe(a.id);
    expect(notes).toHaveLength(1);
    await engine.askOwner({ title: "b" });
    await engine.askOwner({ title: "c" });
    expect(await engine.askOwner({ title: "d" })).toBeNull(); // 3 por dia
    const done = await engine.authorize(a.id);
    expect(done.followUp.taskId).toBe("t9");
    expect(engine.request(a.id).status).toBe("feito");
  });

  it("caixa de entrada (scripts/evolucao.js) roda como comando da dona", async () => {
    const { engine, store } = setup();
    mkdirSync(engine.inboxDir(), { recursive: true });
    writeFileSync(join(engine.inboxDir(), "cli-1.json"), JSON.stringify({ command: "status" }));
    const n = await engine.processInbox(async (cmd) => `respondi: ${cmd}`);
    expect(n).toBe(1);
    expect(JSON.parse(readFileSync(join(engine.inboxDir(), "cli-1.done.json"), "utf8")).text).toBe("respondi: status");
    expect(store.dir).toBeTruthy();
  });

  it("teste do ciclo prepara uma mudança de verdade e aprova", async () => {
    const { engine, store, root } = setup();
    mkdirSync(join(root, "src/modules/chat"), { recursive: true });
    writeFileSync(join(root, "src/modules/chat/bubbleComposer.js"), "export const a = 1;\n");
    const r = await engine.selfTest();
    expect(r.ok).toBe(true);
    expect(readFileSync(store.stagedPath(r.changeId, "src/modules/chat/bubbleComposer.js"), "utf8")).toMatch(/teste de ciclo/);
    expect(store.change(r.changeId).status).toBe("aprovado");
  });

  it("reprovado no teste não entra", async () => {
    const { engine, store } = setup({ llmReplies: [PATCH], verify: { ok: false, stage: "testes", details: "quebrou" } });
    const r = await engine.runTask(task);
    expect(r.ok).toBe(false);
    expect(store.change(r.changeId).status).toBe("reprovado");
  });

  it("erro repetido no arquivo que ela mudou → desfaz sozinha e reinicia", async () => {
    const { engine, store, notes, exits } = setup({ llmReplies: [PATCH], supervised: true });
    const r = await engine.runTask(task);
    store.promote(r.changeId);
    const stack = `TypeError: boom\n    at saudar (${join(store.dir, "overlay/src/core/demo/saudacao.js")}:5:3)`;
    engine.noteError({ signature: "boom", stack });
    engine.noteError({ signature: "boom", stack });
    expect(engine.noteError({ signature: "boom", stack })).toBe(true);
    expect(store.change(r.changeId).status).toBe("desfeito");
    expect(notes.at(-1)).toMatch(/desfiz sozinha/);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(exits).toEqual([0]);
  });

  it("modo seguro na subida desfaz a última mudança", async () => {
    const { engine, store } = setup({ llmReplies: [PATCH] });
    const r = await engine.runTask(task);
    store.promote(r.changeId);
    process.env.TETOS_EVOLUTION_SAFE = "1";
    try {
      await engine.onBoot();
    } finally {
      delete process.env.TETOS_EVOLUTION_SAFE;
    }
    expect(store.change(r.changeId).status).toBe("desfeito");
  });
});
