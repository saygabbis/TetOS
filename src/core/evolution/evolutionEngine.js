import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { askModel, clip, parseJsonLoose, shortId } from "../mind/mindText.js";
import { applyBlocks, chooseTargets, proposePatch, repoMap, reviewPatch, stackFiles } from "./codePatcher.js";
import { isEditablePath } from "./safety.js";
import { domainsIn } from "./webTool.js";

const HOUR = 3_600_000;

/**
 * Autoevolução da Teto: cria habilidades novas e muda o próprio código, sozinha, com trava:
 *  - habilidade: escreve → confere → testa isolada → entra no ar na hora (versão anterior guardada);
 *  - código: escolhe arquivo → patch pequeno → regras de segurança → testa (sintaxe, carregar, bateria
 *    de testes) → aprovado → vale no próximo reinício, que ela faz sozinha enquanto "dorme";
 *  - se depois de aplicar a Teto cair seguido (supervisor liga o modo seguro) ou o arquivo mudado
 *    começar a dar erro, ela desfaz a mudança sozinha e avisa a dona.
 */
export class EvolutionEngine {
  constructor({
    root,
    dir = "data/evolution",
    store,
    verifier,
    skills,
    llm,
    journal = null,
    notifyOwner = async () => {},
    isAsleep = () => false,
    lastActivityAt = () => 0,
    codeEnabled = true,
    maxCodePerDay = 3,
    supervised = process.env.TETOS_SUPERVISED === "1",
    now = () => Date.now(),
    exit = (code) => process.exit(code)
  } = {}) {
    Object.assign(this, { root, store, verifier, skills, llm, journal, notifyOwner, isAsleep, lastActivityAt, codeEnabled, maxCodePerDay, supervised, now, exit });
    this.dir = resolve(root, dir);
    this.busy = false;
    this.errorCounts = new Map(); // assinatura → { count, since }
  }

  log(type, text, extra = {}) {
    if (this.journal?.write) this.journal.write(type, `🧬 ${text}`, extra);
    else console.log(`[evolução] ${text}`);
  }

  /** Executa uma tarefa da agenda ("habilidade" ou "codigo"). */
  async runTask(task) {
    if (this.busy) return { ok: false, error: "ocupada com outra mudança" };
    this.busy = true;
    try {
      if (task.kind === "habilidade") return await this.createSkill(task);
      if (task.kind === "codigo") return await this.patchCode(task);
      return { ok: false, error: "tipo desconhecido" };
    } finally {
      this.busy = false;
    }
  }

  // ───────────────────────── habilidades ─────────────────────────

  skillPrompt(task, problems = []) {
    return [
      "Você é a Kasane Teto e vai criar uma HABILIDADE nova pra você mesma.",
      `O que ela deve fazer: ${task.title}`,
      task.detail ? `Detalhe: ${clip(task.detail, 600)}` : "",
      "Uma habilidade é um programinha JavaScript que roda isolado quando a mensagem bate num gatilho e devolve um texto curto com o resultado (você usa esse texto pra responder).",
      "Formato EXATO do código:",
      "habilidade({",
      '  nome: "nome-curto",',
      "  async rodar(msg, f) {",
      "    // msg.texto = mensagem; msg.plataforma; msg.grupo (true/false); msg.quem",
      "    // await f.pesquisar(q) → [{ titulo, trecho, url }]  (busca na internet)",
      "    // await f.ler(url) → texto da página (até 3000 letras)",
      "    // await f.web(url, { metodo: \"GET\"|\"POST\", corpo, cabecalhos }) → { status, json } ou { status, text } — qualquer API pública (sem chave)",
      "    // f.lembrar(chave) lê / f.lembrar(chave, valor) guarda (memória da habilidade)",
      "    // f.agora() → data/hora ISO",
      '    return "texto curto com o resultado";',
      "  }",
      "});",
      "Proibido usar: require, import, process, fetch, eval, Function, constructor, prototype, globalThis, Buffer, setInterval, while(true). Só JavaScript puro (Math, Date, JSON, String, RegExp, Intl).",
      "Se não der pra resolver, devolva um texto dizendo o que faltou (não invente resultado).",
      "Habilidade é pra fazer o que você NÃO consegue só pensando: buscar dado atual (cotação, clima, placar, lançamento), calcular, converter, consultar uma API. NÃO crie habilidade pra ler tom, sentimento, intenção ou subtexto — isso você já faz sozinha, e melhor.",
      "Gatilhos: específicos do assunto (ex.: 'cota[çc][ãa]o do d[óo]lar', 'converte .* (d[óo]lar|euro)'), nunca palavra solta do dia a dia ('ajuda', 'olha isso', 'socorro') nem nada de crise.",
      problems.length ? `A tentativa anterior falhou por: ${problems.join("; ")}. Corrija.` : "",
      "Responda SÓ com JSON:",
      '{"nome":"...","descricao":"o que faz","gatilhos":["regex JavaScript sem barras, específica"],"exemplo":"uma mensagem que aciona o gatilho","codigo":"habilidade({...})"}',
      "Gatilhos específicos (não podem acionar em qualquer conversa), sem quantificador aninhado tipo (a+)+."
    ]
      .filter(Boolean)
      .join("\n");
  }

  async createSkill(task) {
    let problems = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const json = parseJsonLoose(await askModel(this.llm, this.skillPrompt(task, problems), { timeoutMs: 180_000 }).catch(() => ""));
      if (!json?.codigo) {
        problems = ["resposta sem código"];
        continue;
      }
      const result = await this.skills.install({
        name: json.nome || task.title,
        description: json.descricao || task.title,
        triggers: Array.isArray(json.gatilhos) ? json.gatilhos : [],
        example: json.exemplo || "",
        code: String(json.codigo)
      });
      if (result.ok) {
        const domains = domainsIn(json.codigo);
        this.log("habilidade", `criei a habilidade "${json.nome}" (${clip(json.descricao, 120)})`, { slug: result.slug });
        this.feel?.("orgulho", 0.3, `criei uma habilidade nova: ${clip(json.nome, 50)}`);
        await this.notifyOwner(
          [
            `🧩 criei uma habilidade nova em mim: ${json.nome} — ${clip(json.descricao, 140)}`,
            domains.length ? `conecta em: ${domains.join(", ")}` : "",
            `teste: ${clip(result.sample, 140)}`,
            `pra desligar: .mente desfazer ${result.slug}`
          ]
            .filter(Boolean)
            .join("\n"),
          { kind: "info" }
        ).catch(() => {});
        return { ok: true, summary: `habilidade "${json.nome}" pronta — teste: ${clip(result.sample, 160)}`, slug: result.slug };
      }
      problems = result.problems ?? ["falhou"];
    }
    this.log("habilidade-falhou", `não consegui criar "${task.title}": ${problems.join("; ")}`);
    return { ok: false, error: problems.join("; ") };
  }

  // ───────────────────────── código ─────────────────────────

  codeChangesToday() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return this.store.manifest.changes.filter((c) => String(c.createdAt).startsWith(day)).length;
  }

  async patchCode(task) {
    if (!this.codeEnabled) return { ok: false, error: "mudança de código desligada" };
    if (this.store.manifest.paused) return { ok: false, error: "evolução pausada pela dona" };
    if (this.codeChangesToday() >= this.maxCodePerDay) return { ok: false, error: "limite de mudanças de hoje" };

    const fromStack = stackFiles(task.detail ?? "", this.root).filter((f) => isEditablePath(f.rel, this.store.currentContent(f.rel) ?? "").approvable);
    let targets = fromStack.slice(0, 2).map((f) => f.rel);
    const focus = Object.fromEntries(fromStack.map((f) => [f.rel, [f.line]]));
    let plan = "";
    if (!targets.length) {
      const chosen = await chooseTargets(this.llm, { goal: task.title, detail: task.detail, map: repoMap(this.root) }).catch(() => ({ files: [], plan: "" }));
      targets = chosen.files;
      plan = chosen.plan;
    }
    if (!targets.length) {
      // Precisa de algo fora do alcance dela (pacote, chave, arquivo fora de src/): pede pra dona.
      if (plan) {
        const req = await this.askOwner({ title: task.title, why: plan, needs: "mudança fora do meu alcance (fora de src/, pacote, chave ou configuração)", taskId: task.id });
        if (req) return { ok: true, summary: `pedi pra Gabbis: ${clip(plan, 160)}`, requestId: req.id };
      }
      this.log("codigo-falhou", `não achei onde mexer pra "${task.title}"${plan ? `: ${plan}` : ""}`);
      return { ok: false, error: plan || "nenhum arquivo adequado" };
    }

    const before = Object.fromEntries(targets.map((rel) => [rel, this.store.currentContent(rel) ?? ""]));
    let problems = [];
    let applied = null;
    let needs = [];
    let explanation = "";
    for (let attempt = 0; attempt < 2 && !applied; attempt += 1) {
      const detail = [task.detail, problems.length ? `Tentativa anterior rejeitada: ${problems.join("; ")}` : ""].filter(Boolean).join("\n");
      const proposal = await proposePatch(this.llm, { goal: task.title, detail, plan, files: before, focus }).catch((e) => ({ blocks: [], explanation: e.message }));
      explanation = proposal.explanation;
      if (!proposal.blocks.length) {
        problems = [proposal.explanation || "sem patch"];
        continue;
      }
      const res = applyBlocks(before, proposal.blocks);
      if (!res.ok) {
        problems = res.problems;
        continue;
      }
      const review = reviewPatch(this.root, before, res.files);
      if (review.hard.length) {
        problems = review.hard;
        continue;
      }
      needs = review.approval;
      applied = Object.fromEntries(review.changed.map((rel) => [rel, res.files[rel]]));
    }
    if (!applied) {
      this.log("codigo-falhou", `patch pra "${task.title}" não passou: ${problems.join("; ")}`);
      return { ok: false, error: problems.join("; ") };
    }

    const id = shortId("c");
    this.store.stage(id, applied, { reason: clip(task.title, 200), explanation, by: task.requesters?.[0]?.name ?? "ela mesma", taskId: task.id });
    // Mexe em parte restrita: não testa nem aplica sozinha — pede autorização pra dona, dizendo o que quer.
    if (needs.length) {
      this.store.setStatus(id, "aguardando", { needs });
      this.log("codigo-pedido", `pedi autorização pra mudança ${id} (${needs.length} ponto(s) restrito(s))`, { id });
      await this.notifyOwner(
        [
          `🙋 queria mudar uma parte restrita de mim: ${clip(task.title, 120)}`,
          explanation ? `por quê: ${clip(explanation, 260)}` : "",
          `precisa de autorização porque: ${needs.slice(0, 4).map((n) => clip(n, 90)).join("; ")}`,
          `arquivos: ${Object.keys(applied).join(", ")}`,
          `ver: .mente ver ${id} · deixar: .mente autorizar ${id} · não: .mente recusar ${id}`
        ]
          .filter(Boolean)
          .join("\n"),
        { kind: "decisao" }
      ).catch(() => {});
      return { ok: true, summary: `pedi autorização pra Gabbis (${id})`, changeId: id };
    }
    return this.verifyAndApprove(id, { title: task.title, explanation });
  }

  /** Testa uma mudança preparada; aprovada → avisa a dona e espera o reinício. */
  async verifyAndApprove(id, { title = "", explanation = "", authorized = false, kind = authorized ? "decisao" : "info" } = {}) {
    const change = this.store.change(id);
    this.log("codigo-teste", `testando mudança ${id} em ${change?.files?.join(", ")}`, { id });
    const result = await this.verifier.verify(id).catch((e) => ({ ok: false, stage: "verificador", details: e.message }));
    if (!result.ok) {
      this.store.setStatus(id, "reprovado", { verify: `${result.stage}: ${clip(result.details, 600)}` });
      this.log("codigo-reprovado", `mudança ${id} reprovada no teste (${result.stage})`, { id });
      this.feel?.("frustracao", 0.2, `minha mudança "${clip(title, 60)}" não passou nos testes`);
      if (authorized) await this.notifyOwner(`😕 a mudança ${id} que você autorizou não passou nos testes (${result.stage}). descartei, nada mudou.`, { kind: "alerta" }).catch(() => {});
      return { ok: false, error: `reprovada no teste (${result.stage})`, changeId: id };
    }
    this.store.setStatus(id, "aprovado", { verify: result.details });
    this.log("codigo-aprovado", `mudança ${id} aprovada (${result.details}) — entra no próximo reinício`, { id });
    this.feel?.("orgulho", 0.3, `consegui melhorar meu próprio código: ${clip(title, 60)}`);
    await this.notifyOwner(
      `🧬 ${authorized ? "a mudança que você autorizou passou" : "mudei um pedacinho de mim"}: ${clip(title, 120)}\n${explanation ? `${clip(explanation, 200)}\n` : ""}arquivos: ${change?.files?.join(", ")} · passou nos testes · aplico quando eu for dormir (ou .mente aplicar)\npra desfazer: .mente desfazer ${id}`,
      { kind }
    ).catch(() => {});
    return { ok: true, summary: `mudança ${id} aprovada nos testes; aplico no próximo reinício`, changeId: id };
  }

  // ───────────────────────── autorização da dona ─────────────────────────

  /** Dona autorizou: mudança restrita vai pro teste; pedido "à mão" vira feito (e a tarefa volta pra agenda). */
  async authorize(id) {
    const change = this.store.change(id);
    if (change?.status === "aguardando") {
      if (this.busy) return { ok: false, text: "tô no meio de outra mudança — tenta de novo daqui a pouco" };
      this.store.setStatus(id, "autorizado");
      this.busy = true;
      void this.verifyAndApprove(id, { title: change.reason, explanation: change.explanation, authorized: true })
        .catch((e) => this.log("codigo-falhou", `erro testando ${id}: ${e?.message ?? e}`))
        .finally(() => {
          this.busy = false;
        });
      return { ok: true, text: `obrigada! testando ${id} agora (leva uns minutos) — te aviso` };
    }
    const req = this.request(id);
    if (req?.status === "aguardando") {
      req.status = "feito";
      req.doneAt = new Date(this.now()).toISOString();
      this.store.save();
      this.log("pedido-feito", `a Gabbis fez o que eu pedi: ${clip(req.title, 100)}`, { id });
      this.feel?.("gratidao", 0.3, `a Gabbis fez o que eu pedi: ${clip(req.title, 60)}`);
      return { ok: true, text: `ebaa, valeu! vou tentar de novo "${clip(req.title, 80)}"`, followUp: req };
    }
    return { ok: false, text: "não tem nada esperando com esse id (veja .mente pedidos)" };
  }

  refuse(id, reason = "") {
    const change = this.store.change(id);
    const req = this.request(id);
    if (change?.status === "aguardando") this.store.setStatus(id, "recusado", { reason: clip(reason, 200) });
    else if (req?.status === "aguardando") {
      req.status = "recusado";
      req.reason = clip(reason, 200);
      this.store.save();
    } else return { ok: false, text: "não tem nada esperando com esse id" };
    this.log("recusado", `a Gabbis recusou ${id}${reason ? `: ${reason}` : ""}`, { id });
    this.feel?.("frustracao", 0.12, `a Gabbis recusou o que eu pedi${reason ? ` (${clip(reason, 60)})` : ""}`);
    return { ok: true, text: reason ? `tá bom… anotei o motivo` : "tá bom, deixo quieto" };
  }

  request(id) {
    return (this.store.manifest.requests ?? []).find((r) => r.id === id) ?? null;
  }

  /** Pede pra dona algo que ela não alcança sozinha (pacote, chave, conta, arquivo fora de src/). */
  async askOwner({ title, why = "", needs = "", taskId = null, by = null } = {}) {
    const list = (this.store.manifest.requests ??= []);
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (list.filter((r) => String(r.createdAt).startsWith(day)).length >= 3) return null;
    const open = list.find((r) => r.status === "aguardando" && String(r.title).toLowerCase() === String(title).toLowerCase());
    if (open) return open;
    const req = { id: shortId("p"), title: clip(title, 160), why: clip(why, 400), needs: clip(needs, 200), taskId, by, status: "aguardando", createdAt: new Date(this.now()).toISOString() };
    list.push(req);
    this.store.manifest.requests = list.slice(-60);
    this.store.save();
    this.log("pedido", `pedi pra Gabbis: ${req.title}`, { id: req.id });
    await this.notifyOwner(
      `🙋 Gabbis, queria te pedir uma coisa: ${req.title}\n${req.why ? `${req.why}\n` : ""}${req.needs ? `(${req.needs})\n` : ""}quando fizer: .mente autorizar ${req.id} · se não: .mente recusar ${req.id}`,
      { kind: "decisao" }
    ).catch(() => {});
    return req;
  }

  /** Pendências pra dona decidir. */
  pending() {
    const changes = this.store.manifest.changes.filter((c) => c.status === "aguardando").map((c) => ({ id: c.id, kind: "mudança", title: c.reason, detail: (c.needs ?? []).join("; ") }));
    const requests = (this.store.manifest.requests ?? []).filter((r) => r.status === "aguardando").map((r) => ({ id: r.id, kind: "pedido", title: r.title, detail: r.why }));
    return [...changes, ...requests];
  }

  /** Diferença de uma mudança (o que sai / o que entra), pra dona ler antes de autorizar. */
  diff(id, { maxChars = 3000 } = {}) {
    const c = this.store.change(id);
    if (!c) return null;
    const out = [`mudança ${id} [${c.status}] — ${c.reason}`, c.explanation ? `por quê: ${c.explanation}` : "", ...(c.needs?.length ? [`restrito: ${c.needs.join("; ")}`] : [])];
    for (const rel of c.files) {
      const after = existsSync(this.store.stagedPath(id, rel)) ? readFileSync(this.store.stagedPath(id, rel), "utf8") : "";
      const before = existsSync(this.store.backupPath(id, rel)) ? readFileSync(this.store.backupPath(id, rel), "utf8") : this.store.currentContent(rel) ?? "";
      const a = before.split("\n");
      const b = after.split("\n");
      const removed = a.filter((l) => !b.includes(l)).slice(0, 40);
      const added = b.filter((l) => !a.includes(l)).slice(0, 60);
      out.push(`\n📄 ${rel}`, ...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`));
    }
    const text = out.filter(Boolean).join("\n");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cortado)` : text;
  }

  // ───────────────────────── teste do ciclo / pedidos de fora ─────────────────────────

  /**
   * Teste do ciclo completo: uma mudança de verdade (linha de log no começo de um módulo carregado na
   * subida) passa pelo teste, é aprovada e aplicada no próximo reinício — aí o log prova que a versão
   * dela carregou. Depois é só desfazer.
   */
  async selfTest() {
    if (this.busy) return { ok: false, error: "ocupada com outra mudança" };
    const rel = "src/modules/chat/bubbleComposer.js";
    const current = this.store.currentContent(rel);
    if (!current) return { ok: false, error: "módulo de teste não existe" };
    const id = shortId("t");
    const marker = `console.log("[evolução] teste de ciclo ${id}: estou rodando a versão que eu mesma mudei");`;
    this.store.stage(id, { [rel]: `${marker}\n${current}` }, { reason: "teste do ciclo completo (testar, aplicar, reiniciar)", explanation: "uma linha de log no começo do módulo pra provar que a minha versão carregou", by: "teste", selfTest: true });
    this.busy = true;
    try {
      return await this.verifyAndApprove(id, { title: "teste do ciclo completo", explanation: `procure no log: teste de ciclo ${id}`, kind: "decisao" });
    } finally {
      this.busy = false;
    }
  }

  inboxDir() {
    return join(this.dir, "inbox");
  }

  /**
   * Pedidos de fora (`node scripts/evolucao.js …` no servidor): <id>.json → resposta em <id>.done.json.
   * Quem tem acesso ao servidor é a dona, então roda como comando dela.
   */
  async processInbox(handler) {
    const dir = this.inboxDir();
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const name of readdirSync(dir).filter((f) => /^[\w-]+\.json$/.test(f) && !f.endsWith(".done.json"))) {
      const path = join(dir, name);
      let req = null;
      try {
        req = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        /* pedido ilegível: descarta */
      }
      rmSync(path, { force: true });
      if (!req?.command) continue;
      const text = await Promise.resolve(handler(String(req.command))).catch((e) => `erro: ${e?.message ?? e}`);
      writeFileSync(join(dir, name.replace(/\.json$/, ".done.json")), JSON.stringify({ at: new Date(this.now()).toISOString(), text: String(text) }));
      n += 1;
    }
    return n;
  }

  // ───────────────────────── aplicar / reiniciar / desfazer ─────────────────────────

  restartFlagPath() {
    return join(this.dir, "restart.json");
  }

  /** Reinicia pra valer o código novo (só com o supervisor por perto; sem ele, vale no próximo start). */
  restart(reason) {
    if (!this.supervised) {
      this.log("reinicio-adiado", `"${reason}" vale no próximo reinício (sem supervisor pra me religar)`);
      return false;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.restartFlagPath(), JSON.stringify({ at: new Date(this.now()).toISOString(), reason }));
    this.store.manifest.lastRestartAt = new Date(this.now()).toISOString();
    this.store.save();
    this.log("reinicio", `reiniciando: ${reason}`);
    setTimeout(() => this.exit(0), 1500).unref?.();
    return true;
  }

  /**
   * Aplica as mudanças aprovadas: na hora se `force`, senão só quando ela está dormindo, ninguém
   * falou com ela há 10 min e não reiniciou nas últimas 6 h.
   */
  maybeApply({ force = false } = {}) {
    const ready = this.store.ready();
    if (!ready.length || this.store.manifest.paused) return false;
    if (!force) {
      const quiet = this.now() - (this.lastActivityAt() || 0) > 10 * 60_000;
      const lastRestart = Date.parse(this.store.manifest.lastRestartAt ?? 0) || 0;
      if (!this.isAsleep() || !quiet || this.now() - lastRestart < 6 * HOUR) return false;
    }
    if (!this.supervised && !force) return false;
    for (const c of ready) this.store.promote(c.id);
    this.log("aplicou", `apliquei ${ready.map((c) => c.id).join(", ")}`);
    return this.restart(`aplicar ${ready.map((c) => c.id).join(", ")}`);
  }

  /** Desfaz (pedido da dona ou automático). Se estava valendo, reinicia pra sair do ar. */
  revert(id, reason = "pedido da dona") {
    const c = this.store.change(id);
    if (!c) return { ok: false, error: "não achei essa mudança" };
    const wasActive = c.status === "ativo";
    this.store.revert(id, reason);
    this.log("desfez", `desfiz ${id} (${reason})`, { id });
    if (wasActive) this.restart(`desfazer ${id}`);
    return { ok: true, wasActive };
  }

  /** Na subida: trata modo seguro (queda seguida depois de mudança) e versões tiradas do ar por deploy. */
  async onBoot() {
    const restartFlag = this.restartFlagPath();
    if (existsSync(restartFlag)) rmSync(restartFlag, { force: true });
    // Habilidades antigas passam pelas regras atuais (gatilho genérico/de crise sai; sem gatilho bom, desliga).
    for (const c of this.skills?.audit?.() ?? []) {
      this.log("habilidade-revisada", `revisei a habilidade "${c.name}": ${c.disabled ? "desliguei" : `tirei ${c.removed.length} gatilho(s)`} (${clip(c.why, 120)})`, { slug: c.slug });
    }
    const notes = this.store.manifest.notes.filter((n) => !n.seen);
    for (const n of notes) {
      n.seen = true;
      this.log("deploy", n.text);
    }
    if (notes.length) {
      this.store.save();
      await this.notifyOwner(`🧬 ${notes.map((n) => n.text).join("\n")}`, { kind: "info" }).catch(() => {});
    }
    if (process.env.TETOS_EVOLUTION_SAFE === "1") {
      const culprit = this.store.latestActive();
      if (culprit) {
        this.store.revert(culprit.id, "caí seguido depois dessa mudança (modo seguro)");
        this.log("rollback", `caí seguido depois de ${culprit.id} — desfiz sozinha`, { id: culprit.id });
        this.feel?.("frustracao", 0.35, `caí depois de mudar meu código (${culprit.id}) e tive que desfazer`);
        await this.notifyOwner(`⚠️ caí duas vezes seguidas depois de mudar "${clip(culprit.reason, 100)}" (${culprit.id}). desfiz sozinha e tô voltando normal.`, { kind: "alerta" }).catch(() => {});
        // Volta com as outras mudanças que estavam boas.
        this.restart("sair do modo seguro");
      }
    }
  }

  /**
   * Erro no ar: se vier de arquivo que ela mudou nas últimas 24 h e repetir 3x, desfaz sozinha.
   * @param {{ signature: string, stack?: string }} err
   */
  noteError({ signature, stack = "" }) {
    const files = stackFiles(stack, this.root).map((f) => f.rel);
    const active = this.store.manifest.active;
    for (const rel of files) {
      const info = active[rel];
      if (!info) continue;
      const change = this.store.change(info.changeId);
      if (!change?.activeAt || this.now() - Date.parse(change.activeAt) > 24 * HOUR) continue;
      const key = `${change.id}:${signature}`;
      const row = this.errorCounts.get(key) ?? { count: 0 };
      row.count += 1;
      this.errorCounts.set(key, row);
      if (row.count >= 3) {
        this.errorCounts.delete(key);
        this.log("rollback", `erro repetido depois de ${change.id} (${clip(signature, 100)}) — desfazendo`, { id: change.id });
        this.feel?.("vergonha", 0.3, `uma mudança minha (${change.id}) deu erro e tive que desfazer`);
        void this.notifyOwner(`⚠️ a mudança ${change.id} ("${clip(change.reason, 80)}") começou a dar erro. desfiz sozinha.`, { kind: "alerta" }).catch(() => {});
        this.revert(change.id, `erro repetido: ${clip(signature, 120)}`);
        return true;
      }
    }
    return false;
  }

  status() {
    const changes = [...this.store.manifest.changes].reverse().slice(0, 8);
    return {
      paused: this.store.manifest.paused,
      codeEnabled: this.codeEnabled,
      supervised: this.supervised,
      active: Object.keys(this.store.manifest.active),
      changes: changes.map((c) => ({ id: c.id, status: c.status, reason: c.reason, files: c.files, at: c.activeAt ?? c.createdAt })),
      skills: this.skills.list().map((s) => ({ slug: s.slug, name: s.name, enabled: s.enabled, uses: s.uses ?? 0 }))
    };
  }

  setPaused(paused) {
    this.store.manifest.paused = Boolean(paused);
    this.store.save();
  }

  /** Código de uma mudança/arquivo pra dona conferir (resumido). */
  describe(id) {
    const c = this.store.change(id);
    if (!c) return null;
    const files = c.files.map((rel) => {
      const p = c.status === "ativo" ? this.store.overlayPath(rel) : this.store.stagedPath(id, rel);
      return { rel, exists: existsSync(p), size: existsSync(p) ? readFileSync(p, "utf8").length : 0 };
    });
    return { ...c, files };
  }
}
