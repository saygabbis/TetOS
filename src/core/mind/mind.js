import { join } from "node:path";
import { KnowledgeBase } from "./knowledgeBase.js";
import { LessonBook } from "./lessonBook.js";
import { MindAgenda, MindJournal } from "./mindAgenda.js";
import { measureTurns, reflect, sampleTurns, TurnLog } from "./reflection.js";
import { lookupQuery, studyTopic } from "./research.js";
import { detectSelfRequest, judgeRequest, judgmentPromptLines } from "./requestJudge.js";
import { askModel, clip, parseJsonLoose } from "./mindText.js";
import { appraise, FeelingEngine } from "./feelings.js";
import { stackFiles } from "../evolution/codePatcher.js";
import { isEditablePath } from "../evolution/safety.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOISY_ERRORS = /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|tempo esgotado|abort|stream errored|Bad MAC|decrypt|rate.?limit|429|50\d|Connection Closed|precondition|not-acceptable|Ollama error|MiniMax error|fetch failed|getaddrinfo|disallowed intents/i;

/**
 * A mente da Teto: junta o que ela estudou, as lições que tirou de si mesma, a agenda (estudar / criar
 * habilidade / mudar o próprio código), o julgamento dos pedidos e a autoevolução. Fala com o resto do
 * sistema por três pontos: `prepareTurn` (antes de responder), `recordTurn` (depois) e `start` (ciclos
 * em segundo plano). Orçamentos ficam aqui (protegido: ela não mexe neste arquivo).
 */
export class Mind {
  constructor({
    dir = "./data/mind",
    llm = null,
    search = null,
    reader = null,
    evolution = null,
    life = null,
    persona = "Kasane Teto: cantora virtual (UTAU/SynthV), travessa, tsundere leve, carinhosa do jeito dela, ama pão/baguete e música",
    notifyOwner = async () => {},
    limits = {},
    now = () => Date.now()
  } = {}) {
    this.dir = dir;
    this.llm = llm;
    this.search = search; // (q) => [{title, url, snippet}]
    this.reader = reader; // { read(url) }
    this.evolution = evolution;
    this.life = life;
    this.persona = persona;
    this.notifyOwner = notifyOwner;
    this.now = now;
    this.limits = {
      studyPerDay: 10,
      studyEveryMs: 40 * MIN,
      reflectEveryMs: 4 * HOUR,
      evolveEveryMs: 30 * MIN,
      lookupsPerDay: 80,
      ...limits
    };
    const p = (name) => (dir ? join(dir, name) : null);
    this.knowledge = new KnowledgeBase(p("knowledge.json"), { now });
    this.lessons = new LessonBook(p("lessons.json"), { now });
    this.agenda = new MindAgenda(p("agenda.json"), { now });
    this.journal = new MindJournal(p("journal.ndjson"), { now });
    this.turns = new TurnLog(p("turns.json"), { now });
    this.feelings = new FeelingEngine(p("feelings.json"), { now, baseMood: () => life?.mood?.() ?? null });
    this.senders = {};
    this.lastActivityAt = 0;
    this.last = { study: 0, reflect: 0, evolve: 0, decay: 0, interests: 0 };
    this.lookups = { day: "", count: 0, perChat: new Map() };
    this.errors = new Map();
    this.busy = false;
    this.timer = null;
  }

  registerSender(platform, fn) {
    this.senders[platform] = fn;
  }

  isAsleep() {
    try {
      return this.life?.availability?.()?.mode === "asleep";
    } catch {
      return false;
    }
  }

  // ───────────────────────── antes de responder ─────────────────────────

  /** Pesquisa sozinha antes de responder? (pergunta de fato + orçamento do dia) */
  autoLookup(input, chatId) {
    const q = lookupQuery(input);
    if (!q) return null;
    if (this.knowledge.search(input, { limit: 1, minScore: 6 }).length) return null; // já estudou isso
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.lookups.day !== day) this.lookups = { day, count: 0, perChat: new Map() };
    const lastChat = this.lookups.perChat.get(chatId) ?? 0;
    if (this.lookups.count >= this.limits.lookupsPerDay || this.now() - lastChat < 90_000) return null;
    this.lookups.count += 1;
    this.lookups.perChat.set(chatId, this.now());
    return q;
  }

  /**
   * Monta o que a mente acrescenta ao prompt deste turno (e executa a decisão sobre pedidos pra ela).
   * @returns {Promise<{ lines: string[], lookup: string|null, judgment: object|null }>}
   */
  async prepareTurn({ input = "", userId = null, chatId = null, platform = "whatsapp", isGroup = false, isOwner = false, speakerName = null, directed = true, recent = "", tone = null, gapMs = null } = {}) {
    const text = String(input ?? "");
    this.turns.noteIncoming(chatId, text);
    // O que chegou mexe com ela antes de responder (a resposta já sai com o sentimento).
    this.feelings.react(appraise({ text, tone, who: speakerName, isOwner, directed, gapMs }), {
      who: isOwner ? "Gabbis" : speakerName,
      userId,
      chat: chatId,
      platform,
      private: !isGroup
    });
    if (isOwner) this.feelings.noteOwner();
    const lines = [];
    lines.push(...this.feelings.promptLines({ viewerUserId: userId }));
    lines.push(...this.lessons.promptLines({ platform, isGroup }));
    lines.push(...this.knowledge.promptLines(text));

    // Habilidades que ela criou (rodam isoladas; não seguram a resposta mais que ~9 s).
    if (this.evolution?.skills) {
      const skillLines = await Promise.race([
        this.evolution.skills.contextFor(text, { platform, isGroup, speaker: speakerName }).catch(() => []),
        new Promise((r) => setTimeout(() => r([]), 9000))
      ]);
      lines.push(...skillLines);
    }

    // O que ela terminou pra esta pessoa (e ainda não contou).
    const mine = this.agenda.awaitingNotice().filter((t) => t.requesters.some((r) => r.userId === userId));
    if (mine.length) {
      lines.push(
        "[VOCÊ TERMINOU O QUE ESSA PESSOA TE PEDIU — conte se encaixar]",
        ...mine.slice(0, 2).map((t) => `- ${t.title}: ${t.status === "feito" ? clip(t.result?.summary ?? "pronto", 220) : `não consegui (${clip(t.error, 120)})`}`)
      );
      for (const t of mine.slice(0, 2)) this.agenda.markNotified(t.id);
    }

    // Pedido/sugestão pra ela: julga e executa de verdade.
    let judgment = null;
    const request = detectSelfRequest(text, { directed });
    if (request) {
      judgment = await judgeRequest(this.llm, {
        request: text,
        who: speakerName,
        isOwner,
        platform,
        isGroup,
        lessons: this.lessons.active({ platform, isGroup, limit: 8 }),
        persona: this.persona,
        recent
      });
      if (judgment) this.applyJudgment(judgment, { text, userId, chatId, platform, isGroup, isOwner, speakerName });
      lines.push(...judgmentPromptLines(judgment, request));
    }

    return { lines, lookup: this.autoLookup(text, chatId), judgment };
  }

  applyJudgment(j, ctx) {
    const requestedBy = { userId: ctx.userId, name: ctx.speakerName, platform: ctx.platform, chatId: ctx.chatId, isGroup: ctx.isGroup, isOwner: ctx.isOwner };
    const later = j.decision === "depois";
    if (j.decision === "recusar" || j.type === "nada") {
      this.journal.write("recusou", `recusei pedido de ${ctx.speakerName ?? "alguém"}: ${clip(ctx.text, 120)} — ${j.reason}`);
      return;
    }
    if (j.type === "licao" && j.rule && !later) {
      // Pedido de outra pessoa só muda o jeito dela naquela plataforma (troll do Discord não mexe no PV da dona).
      const lesson = this.lessons.add({ rule: j.rule, why: j.reason, source: ctx.isOwner ? "pedido-dona" : "pedido", strength: ctx.isOwner ? 0.85 : 0.5, scope: ctx.isOwner ? "geral" : ctx.platform, evidence: clip(ctx.text, 200) });
      this.journal.write("licao", `aceitei mudar: ${j.rule}`, { id: lesson?.id, by: ctx.speakerName });
      return;
    }
    // Precisa de algo que só a dona faz (chave, conta, pacote, parte restrita): manda o pedido pra ela.
    if (j.type === "pedir") {
      void this.evolution
        ?.askOwner?.({ title: j.topic || clip(ctx.text, 120), why: [j.reason, j.detail].filter(Boolean).join(" — "), needs: j.detail, by: ctx.speakerName })
        .then((req) => req && this.journal.write("pedido", `pedi pra Gabbis por causa de ${ctx.speakerName ?? "alguém"}: ${req.title}`, { id: req.id }))
        .catch(() => {});
      return;
    }
    const kind = { estudar: "estudar", habilidade: "habilidade", codigo: "codigo" }[j.type];
    if (!kind) return;
    const task = this.agenda.add({
      kind,
      title: j.topic || clip(ctx.text, 120),
      detail: [j.detail, `Pedido original: ${clip(ctx.text, 300)}`].filter(Boolean).join("\n"),
      priority: later ? 0.3 : ctx.isOwner ? 0.9 : 0.6,
      requestedBy,
      source: "pedido"
    });
    this.journal.write("agenda", `${later ? "depois" : "aceitei"}: ${kind} — ${task?.title}`, { id: task?.id, by: ctx.speakerName });
  }

  /** Depois de responder: guarda a troca pra revisão. */
  recordTurn({ chatId, platform, isGroup, who, input, replies = [], actions = [], toneRead = null } = {}) {
    const stickers = (actions ?? []).filter((a) => a?.type === "sticker").length;
    this.turns.record({ chat: chatId, platform, isGroup, who, input, replies, stickers, tone: toneRead });
    if (replies.length || stickers) this.lastActivityAt = this.now();
  }

  // ───────────────────────── ciclos em segundo plano ─────────────────────────

  start({ intervalMs = MIN } = {}) {
    if (this.timer) return;
    this.agenda.recover();
    this.installErrorWatch();
    void this.evolution?.onBoot?.().catch((e) => console.warn("[mente] boot da evolução:", e?.message ?? e));
    this.timer = setInterval(() => void this.tick().catch((e) => console.warn("[mente] ciclo:", e?.message ?? e)), intervalMs);
    this.timer.unref?.();
    this.journal.write("acordou", "mente ligada");
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      await this.deliverNotices();
      // Comandos de fora (node scripts/evolucao.js … no servidor) = comandos da dona.
      await this.evolution?.processInbox?.((cmd) => this.command(cmd, { isOwner: true }));
      this.evolution?.maybeApply?.();
      if (now - this.last.decay > 24 * HOUR) {
        this.last.decay = now;
        this.lessons.decay();
      }
      const asleep = this.isAsleep();
      this.feelings.tickIdle({ lastActivityAt: this.lastActivityAt, asleep });
      // Estudar: acordada, no ritmo e dentro do orçamento do dia.
      if (!asleep && now - this.last.study >= this.limits.studyEveryMs && this.agenda.doneToday("estudar") < this.limits.studyPerDay) {
        this.last.study = now;
        await this.studyNext();
      } else if (now - this.last.reflect >= this.limits.reflectEveryMs && this.turns.since(this.last.reflect || now - 12 * HOUR).length >= 15) {
        this.last.reflect = now;
        await this.reflectNow();
      } else if (now - this.last.evolve >= this.limits.evolveEveryMs && !this.evolving) {
        // Mudança de código leva minutos (testes): roda em paralelo pra não travar estudo e avisos.
        this.last.evolve = now;
        this.evolving = true;
        void this.evolveNext()
          .catch((e) => console.warn("[mente] evolução:", e?.message ?? e))
          .finally(() => {
            this.evolving = false;
          });
      }
    } finally {
      this.busy = false;
    }
  }

  /** Estuda o próximo tema da agenda (ou escolhe um interesse dela se a agenda estiver vazia). */
  async studyNext() {
    let task = this.agenda.next(["estudar"]);
    if (!task && this.now() - this.last.interests > 12 * HOUR) {
      this.last.interests = this.now();
      await this.pickInterests();
      task = this.agenda.next(["estudar"]);
    }
    if (!task || !this.search || !this.llm) return null;
    this.agenda.start(task.id);
    try {
      const learned = await studyTopic({ topic: task.title, why: task.detail, search: this.search, reader: this.reader, llm: this.llm, persona: this.persona });
      if (!learned) {
        this.agenda.fail(task.id, "não achei nada que prestasse");
        this.journal.write("estudo-falhou", `não achei material bom sobre "${task.title}"`);
        return null;
      }
      const entry = this.knowledge.add({ ...learned, by: task.requesters?.length ? "pedido" : "curiosidade" });
      this.agenda.finish(task.id, { summary: clip(`${entry.summary}${learned.opinion ? ` (minha opinião: ${learned.opinion})` : ""}`, 400), knowledgeId: entry.id });
      this.journal.write("estudou", `estudei "${entry.topic}": ${clip(entry.summary, 160)}`, { id: entry.id });
      this.feelings.feel("curiosidade", 0.2, { cause: `aprendi sobre ${entry.topic}` });
      this.feelings.feel("orgulho", 0.1, { cause: `aprendi sobre ${entry.topic}` });
      return entry;
    } catch (error) {
      this.agenda.fail(task.id, error?.message ?? String(error));
      return null;
    }
  }

  /** Ela escolhe sozinha o que quer aprender (gostos dela + assuntos que apareceram nas conversas). */
  async pickInterests() {
    const recentTopics = this.turns.turns.slice(-40).map((t) => t.input).filter((t) => t.length > 15).slice(-15);
    const known = this.knowledge.recent(20).map((e) => e.topic);
    const prompt = [
      `Você é a ${this.persona}. Hoje você tem um tempinho livre e quer aprender coisas novas por conta própria.`,
      known.length ? `Você já estudou: ${known.join("; ")}.` : "",
      recentTopics.length ? `Assuntos que apareceram nas suas conversas:\n${recentTopics.map((t) => `- ${clip(t, 120)}`).join("\n")}` : "",
      "Escolha 3 temas DIFERENTES que você ficou curiosa de verdade (música, jogos, animes, tecnologia, cultura, coisas que te perguntaram e você não sabia...). Genéricos, sem nome de pessoa.",
      'Responda só JSON: {"temas":[{"tema":"...","porque":"..."}]}'
    ]
      .filter(Boolean)
      .join("\n");
    const json = parseJsonLoose(await askModel(this.llm, prompt, { timeoutMs: 60_000 }).catch(() => ""));
    for (const t of (json?.temas ?? []).slice(0, 3)) {
      if (t?.tema) this.agenda.add({ kind: "estudar", title: t.tema, detail: t.porque ?? "", priority: 0.35, source: "curiosidade" });
    }
  }

  /** Autorrevisão: mede, pede o julgamento dela mesma e aplica (lições, temas, habilidade). */
  async reflectNow() {
    if (!this.llm) return null;
    const recent = this.turns.turns.slice(-150);
    if (recent.length < 10) return null;
    const metrics = measureTurns(recent);
    const errors = [...this.errors.values()].filter((e) => e.count >= 2).slice(0, 6);
    const result = await reflect(this.llm, {
      metrics,
      sample: sampleTurns(recent),
      lessons: this.lessons.active({ limit: 20 }),
      errors,
      knowledgeTopics: this.knowledge.recent(15).map((e) => e.topic),
      persona: this.persona
    }).catch((e) => {
      console.warn("[mente] revisão:", e?.message ?? e);
      return null;
    });
    if (!result) return null;
    for (const d of result.defects) {
      const lesson = this.lessons.add({ rule: d.rule, why: d.defect, evidence: d.evidence, scope: d.scope, source: "reflexao" });
      if (lesson) this.journal.write("licao", `${lesson.reinforced ? "reforcei" : "aprendi"}: ${d.rule}`, { id: lesson.id });
    }
    for (const r of result.retire) {
      const gone = this.lessons.retire(r.id, r.motivo);
      if (gone) this.journal.write("licao-aposentada", `não preciso mais de: ${gone.rule}`);
    }
    for (const s of result.study) this.agenda.add({ kind: "estudar", title: s.topic, detail: s.why, priority: 0.55, source: "reflexao" });
    if (result.skill) this.agenda.add({ kind: "habilidade", title: result.skill.name, detail: result.skill.purpose, priority: 0.5, source: "reflexao" });
    // Melhoria no próprio sistema: sozinha se for parte livre; parte restrita vira pedido de autorização.
    if (result.improve) this.agenda.add({ kind: "codigo", title: result.improve.goal, detail: result.improve.detail, priority: 0.45, source: "reflexao" });
    if (result.ask) void this.evolution?.askOwner?.({ title: result.ask.what, why: result.ask.why, needs: "só você consegue fazer isso" }).catch(() => {});
    if (result.defects.length) this.feelings.feel("frustracao", 0.08 * result.defects.length, { cause: `percebi ${result.defects.length} defeito(s) meus revisando conversas` });
    this.journal.write("revisao", `revisei ${metrics.n} conversas (risada ${metrics.laughPct}%, figurinha ${metrics.stickerPct}%) — ${result.mood || "ok"}`, { metrics: { ...metrics, complaints: undefined } });
    return { metrics, result };
  }

  /** Próxima tarefa de habilidade/código. Erros repetidos do sistema viram tarefa de correção. */
  async evolveNext() {
    if (!this.evolution) return null;
    for (const e of this.errors.values()) {
      if (e.count >= 3 && !e.queued && e.editable) {
        e.queued = true;
        this.agenda.add({ kind: "codigo", title: `corrigir erro: ${clip(e.message, 100)}`, detail: e.stack, priority: 0.7, source: "erro" });
      }
    }
    const task = this.agenda.next(["habilidade", "codigo"]);
    if (!task) return null;
    this.agenda.start(task.id);
    const result = await this.evolution.runTask(task).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
    if (result.ok) this.agenda.finish(task.id, { summary: result.summary });
    else this.agenda.fail(task.id, result.error);
    return result;
  }

  /** Avisa quem pediu quando ela termina (PV na hora; em grupo, conta quando a pessoa falar com ela). */
  async deliverNotices() {
    for (const task of this.agenda.awaitingNotice().slice(0, 3)) {
      const age = this.now() - Date.parse(task.doneAt ?? task.createdAt);
      const target = task.requesters.find((r) => !r.isGroup && this.senders[r.platform]);
      if (!target) {
        if (age > 3 * 24 * HOUR) this.agenda.markNotified(task.id);
        continue;
      }
      const text = await this.noticeText(task, target).catch(() => null);
      if (!text) continue;
      try {
        await this.senders[target.platform]({ chatId: target.chatId, userId: target.userId, text });
        this.agenda.markNotified(task.id);
        this.journal.write("avisou", `avisei ${target.name ?? "quem pediu"}: ${clip(task.title, 80)}`);
      } catch (e) {
        if (age > 24 * HOUR) this.agenda.markNotified(task.id);
      }
    }
  }

  async noticeText(task, target) {
    const done = task.status === "feito";
    const prompt = [
      `Você é a ${this.persona}, no ${target.platform === "discord" ? "Discord" : "WhatsApp"}, falando com ${target.name ?? "a pessoa"}${target.isOwner ? " (Gabbis, sua dona)" : ""}.`,
      `Um tempo atrás essa pessoa te pediu: «${clip(task.detail?.split("Pedido original:")[1] ?? task.title, 200)}».`,
      done ? `Você TERMINOU: ${clip(task.result?.summary ?? task.title, 400)}` : `Você tentou mas NÃO conseguiu (${clip(task.error, 160)}).`,
      "Escreva UMA mensagem curta de chat contando isso, do seu jeito (natural, sem kkk, sem emoji demais, sem dizer que é IA). Só o texto da mensagem."
    ].join("\n");
    const raw = await askModel(this.llm, prompt, { timeoutMs: 45_000 });
    const text = String(raw ?? "")
      .replace(/^mensagem\(\s*["']?|["']?\s*\)\s*$/g, "")
      .replace(/^["'“]|["'”]$/g, "")
      .trim();
    return text ? clip(text, 600) : null;
  }

  // ───────────────────────── erros do sistema ─────────────────────────

  /** Escuta console.error: erro com pilha em arquivo dela vira tarefa de correção (e rollback se for mudança nova). */
  installErrorWatch() {
    if (this.errorWatchInstalled) return;
    this.errorWatchInstalled = true;
    const original = console.error.bind(console);
    console.error = (...args) => {
      original(...args);
      try {
        this.captureError(args);
      } catch {
        /* nunca atrapalha o log */
      }
    };
  }

  captureError(args = []) {
    const err = args.find((a) => a instanceof Error) ?? null;
    const stack = err?.stack ?? args.map((a) => (typeof a === "string" ? a : a?.stack ?? "")).find((s) => /\n\s+at\s/.test(s)) ?? "";
    if (!stack) return;
    const message = clip(String(err?.message ?? stack.split("\n")[0]), 200);
    if (NOISY_ERRORS.test(message)) return;
    const root = this.evolution?.root ?? process.cwd();
    const frames = stackFiles(stack, root);
    const top = frames[0]?.rel ?? "?";
    const signature = `${message.replace(/\d+/g, "N").slice(0, 120)} @ ${top}`;
    const row = this.errors.get(signature) ?? { count: 0, message, stack: clip(stack, 2000), first: this.now(), signature };
    row.count += 1;
    row.last = this.now();
    row.editable = frames.some((f) => isEditablePath(f.rel).ok);
    this.errors.set(signature, row);
    if (this.errors.size > 200) this.errors.delete(this.errors.keys().next().value);
    this.evolution?.noteError?.({ signature, stack });
  }

  // ───────────────────────── comandos da dona ─────────────────────────

  status({ viewerUserId = null } = {}) {
    const lessons = this.lessons.active({ limit: 6 });
    const pend = this.agenda.pending().slice(0, 6);
    const evo = this.evolution?.status?.();
    const mood = this.feelings.mood();
    const lines = [
      "🧠 *mente da Teto*",
      `humor: ${mood.label}${mood.top ? ` (${mood.top.label}: ${FeelingEngine.visibleCause(mood.top, viewerUserId)})` : ""}`,
      `lições (${this.lessons.lessons.length}): ${lessons.length ? "" : "nenhuma ainda"}`,
      ...lessons.map((l) => `  • ${l.id} — ${clip(l.rule, 110)}`),
      `estudei ${this.knowledge.entries.length} tema(s)${this.knowledge.entries.length ? `: ${this.knowledge.recent(4).map((e) => e.topic).join("; ")}` : ""}`,
      `agenda (${this.agenda.pending().length} pendente): ${pend.map((t) => `${t.kind}: ${clip(t.title, 50)}`).join(" | ") || "vazia"}`
    ];
    if (evo) {
      const waiting = this.evolution.pending();
      if (waiting.length) lines.push(`🙋 esperando você (${waiting.length}): ${waiting.map((p) => `${p.id} ${clip(p.title, 50)}`).join(" | ")}`);
      lines.push(
        `habilidades: ${evo.skills.length ? evo.skills.map((s) => `${s.name}${s.enabled ? "" : " (desligada)"}`).join(", ") : "nenhuma ainda"}`,
        `código: ${evo.paused ? "PAUSADO" : evo.codeEnabled ? "liberado" : "desligado"}${evo.active.length ? ` · ${evo.active.length} arquivo(s) meus no ar` : ""}`,
        ...evo.changes.slice(0, 5).map((c) => `  • ${c.id} [${c.status}] ${clip(c.reason, 80)}`)
      );
    }
    const last = this.journal.tail(4);
    if (last.length) lines.push("últimas coisas:", ...last.map((r) => `  • ${clip(r.text, 110)}`));
    lines.push("comandos: .sentimentos · .mente estudar <tema> · licoes · esquecer <id> · refletir · pedidos · ver <id> · autorizar <id> · recusar <id> · aplicar · desfazer <id> · testar · pausar · retomar");
    return lines.join("\n");
  }

  /** `.mente …` / `/mente` — só a dona. Devolve o texto da resposta. */
  async command(text = "", { isOwner = false, userId = null } = {}) {
    if (!isOwner) return "isso aí é só com a Gabbis 😤";
    const [sub, ...rest] = String(text).trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch ((sub ?? "").toLowerCase()) {
      case "":
      case "status":
        return this.status({ viewerUserId: userId });
      case "estudar":
      case "aprender": {
        if (!arg) return "estudar o quê? (.mente estudar <tema>)";
        const t = this.agenda.add({ kind: "estudar", title: arg, priority: 0.95, requestedBy: null, source: "dona" });
        return `anotado: vou estudar "${t.title}" logo logo 📚`;
      }
      case "licoes":
      case "lições":
        return this.lessons.lessons.length ? this.lessons.lessons.map((l) => `${l.id} (${Math.round(l.strength * 100)}%) — ${l.rule}`).join("\n") : "nenhuma lição ainda";
      case "esquecer": {
        const gone = this.lessons.retire(arg, "a dona pediu");
        return gone ? `ok, esqueci: ${gone.rule}` : "não achei essa lição (veja .mente licoes)";
      }
      case "refletir": {
        const r = await this.reflectNow();
        return r ? `revisei ${r.metrics.n} conversas: ${r.result.defects.map((d) => d.rule).join(" | ") || "nada grave"}` : "não deu pra revisar agora (poucas conversas ou o modelo não respondeu)";
      }
      case "aplicar":
        return this.evolution?.maybeApply?.({ force: true }) ? "aplicando o que eu mudei — volto em segundos" : "não tem mudança aprovada esperando (ou estou sem supervisor pra reiniciar)";
      case "desfazer": {
        if (!arg) return "desfazer o quê? (.mente desfazer <id>)";
        if (this.evolution?.skills?.index?.skills?.[arg]) {
          this.evolution.skills.setEnabled(arg, false, "a dona desligou");
          return `desliguei a habilidade ${arg}`;
        }
        const r = this.evolution?.revert?.(arg, "a dona pediu");
        return r?.ok ? (r.wasActive ? `desfiz ${arg} — reiniciando pra sair do ar` : `descartei ${arg}`) : r?.error ?? "não achei";
      }
      case "humor":
      case "sentimentos":
        return this.feelings.report(arg, { isOwner: true, viewerUserId: userId });
      case "pedidos": {
        const waiting = this.evolution?.pending?.() ?? [];
        if (!waiting.length) return "não tô te pedindo nada agora";
        return ["🙋 *o que eu tô esperando de você*", ...waiting.map((p) => `• ${p.id} (${p.kind}) — ${clip(p.title, 90)}${p.detail ? `\n   ${clip(p.detail, 160)}` : ""}`), "ver: .mente ver <id> · .mente autorizar <id> · .mente recusar <id> [motivo]"].join("\n");
      }
      case "ver":
        if (!arg) return "ver o quê? (.mente ver <id>)";
        return this.evolution?.diff?.(arg) ?? (this.evolution?.request?.(arg) ? `${this.evolution.request(arg).title}\n${this.evolution.request(arg).why}` : "não achei");
      case "autorizar": {
        if (!arg) return "autorizar o quê? (.mente pedidos)";
        const r = await this.evolution?.authorize?.(arg);
        // Pedido "à mão" que a dona fez: a tarefa que dependia disso volta pra agenda.
        const task = r?.followUp?.taskId ? this.agenda.get(r.followUp.taskId) : null;
        if (task) this.agenda.add({ kind: task.kind, title: task.title, detail: `${task.detail}\nA Gabbis já fez o que eu pedi: ${r.followUp.title}`, priority: 0.9, source: "dona" });
        else if (r?.followUp) this.agenda.add({ kind: "codigo", title: r.followUp.title, detail: `${r.followUp.why}\nA Gabbis já fez o que eu pedi.`, priority: 0.8, source: "dona" });
        return r?.text ?? "não deu";
      }
      case "recusar": {
        const [id, ...why] = arg.split(/\s+/);
        if (!id) return "recusar o quê? (.mente pedidos)";
        return this.evolution?.refuse?.(id, why.join(" "))?.text ?? "não deu";
      }
      case "testar":
      case "testar-ciclo": {
        if (!this.evolution) return "evolução desligada";
        void this.evolution
          .selfTest()
          .then((r) => this.journal.write("teste-ciclo", r.ok ? `teste do ciclo aprovado (${r.changeId}) — aplico no próximo reinício` : `teste do ciclo falhou: ${r.error}`))
          .catch((e) => this.journal.write("teste-ciclo", `teste do ciclo deu erro: ${e?.message ?? e}`));
        return "começando o teste do ciclo: preparo uma mudança de verdade, rodo os testes (uns minutos) e ela entra no próximo reinício (quando eu dormir, ou .mente aplicar)";
      }
      case "pausar":
        this.evolution?.setPaused?.(true);
        return "pausei minhas mudanças de código (estudo e lições continuam)";
      case "retomar":
        this.evolution?.setPaused?.(false);
        return "voltei a poder mexer em mim 🧬";
      default:
        return this.status({ viewerUserId: userId });
    }
  }
}
