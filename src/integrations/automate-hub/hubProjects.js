/**
 * Memória, projetos e acompanhamento (hub). A cada mensagem o hub manda `contextText` (memória da conta e, nas
 * conversas de projeto, briefing, fontes, itens abertos e as regras de proatividade do projeto). A Teto lê isso no
 * prompt e age com comandos de texto (`itemProjeto(...)`, `lembrar(...)`…) que viram frames `project` no hub.
 * As permissões, a aprovação de propostas e os limites de proatividade são do hub; aqui só se repassa e se conta o
 * que realmente aconteceu.
 */

const CALL_TIMEOUT_MS = 20_000;
const MAX_CONTEXT = 7000;

/** @type {{ isReady: () => boolean, request: (frame: object, timeoutMs?: number) => Promise<any> } | null} */
let link = null;
/** threadId → projeto da conversa (para os comandos saberem em qual projeto agir). */
const threadProjects = new Map();

export function setHubProjectsLink(next) {
  link = next ?? null;
}

export function resetHubProjects() {
  link = null;
  threadProjects.clear();
}

export function isHubProjectsAvailable() {
  return Boolean(link?.isReady());
}

function text(v, max = 400) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** O que o hub anexa à mensagem: memória/projeto em texto, o id do projeto e se é o início do projeto. */
export function normalizeHubContext(frame) {
  const contextText = text(frame?.contextText, MAX_CONTEXT);
  const projectId = typeof frame?.projectId === "string" && frame.projectId ? frame.projectId.slice(0, 120) : null;
  if (!contextText && !projectId) return null;
  return { contextText, projectId, kickoff: frame?.kickoff === true };
}

export function rememberThreadProject(threadId, ctx) {
  if (!threadId) return;
  if (ctx?.projectId) threadProjects.set(threadId, ctx.projectId);
  else threadProjects.delete(threadId);
  if (threadProjects.size > 500) threadProjects.delete(threadProjects.keys().next().value);
}

export function projectOfThread(threadId) {
  return threadProjects.get(threadId) ?? null;
}

/** Comandos (nome em minúsculas, como o parser os lê). `scope`: precisa de projeto? */
export const PROJECT_COMMANDS = {
  itemprojeto: { op: "item_upsert", needsProject: true },
  statusitem: { op: "item_status", needsProject: true },
  excluiritem: { op: "item_delete", needsProject: true },
  atualizarprojeto: { op: "project_update", needsProject: true },
  fonteprojeto: { op: "source_add", needsProject: true },
  ligarrotina: { op: "routine_link", needsProject: true },
  desligarrotina: { op: "routine_unlink", needsProject: true },
  lembrar: { op: "memory_add", needsProject: false },
};

const ITEM_TYPES = new Set(["task", "spec", "decision"]);
const ITEM_STATUS = new Set(["todo", "doing", "blocked", "done"]);
const OWNERS = new Set(["user", "agent"]);
const CATEGORIES = new Set(["fact", "preference", "episode"]);

const TYPE_ALIAS = { tarefa: "task", task: "task", spec: "spec", especificacao: "spec", "especificação": "spec", decisao: "decision", "decisão": "decision", decision: "decision" };
const STATUS_ALIAS = { fazer: "todo", todo: "todo", andamento: "doing", fazendo: "doing", doing: "doing", bloqueada: "blocked", bloqueado: "blocked", blocked: "blocked", feita: "done", concluida: "done", "concluída": "done", done: "done" };
const OWNER_ALIAS = { usuario: "user", "usuário": "user", user: "user", eu: "user", teto: "agent", ia: "agent", agent: "agent" };
const CATEGORY_ALIAS = { fato: "fact", fact: "fact", preferencia: "preference", "preferência": "preference", preference: "preference", episodio: "episode", "episódio": "episode", episode: "episode" };
const REPEAT_ALIAS = { diario: "day", "diário": "day", dia: "day", day: "day", semanal: "week", semana: "week", week: "week", mensal: "month", mes: "month", "mês": "month", month: "month" };

const pick = (alias, v) => alias[text(v, 40).toLowerCase()];

/**
 * Argumentos posicionais da Teto → frame do hub.
 * @returns {{ frame: object } | { error: string }}
 */
export function buildProjectFrame(op, args = [], { projectId } = {}) {
  const a = args.map((v) => text(String(v ?? ""), 4000));
  const base = { t: "project", op, ...(projectId ? { projectId } : {}) };
  switch (op) {
    case "item_upsert": {
      // itemProjeto("tipo", "título", "detalhe", "dono", "prazo ISO", "repete", "horário", "id")
      const title = text(a[1], 300);
      if (!title) return { error: "falta o título do item" };
      const type = pick(TYPE_ALIAS, a[0]) ?? "task";
      const owner = a[3] ? pick(OWNER_ALIAS, a[3]) : undefined;
      if (a[3] && !owner) return { error: "dono inválido (use usuario ou teto)" };
      const every = a[5] ? pick(REPEAT_ALIAS, a[5]) : undefined;
      if (a[5] && !every) return { error: "repetição inválida (diario, semanal ou mensal)" };
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(a[6] ?? "") ? a[6] : "09:00";
      const item = {
        ...(a[7] ? { id: a[7] } : {}),
        type,
        title,
        ...(a[2] ? { detail: a[2] } : {}),
        ...(owner ? { owner } : {}),
        ...(a[4] ? { dueAt: a[4] } : {}),
        ...(every ? { recurrence: { every, interval: 1, time } } : {}),
      };
      return { frame: { ...base, item } };
    }
    case "item_status": {
      const status = pick(STATUS_ALIAS, a[1]);
      if (!a[0] || !status) return { error: "faltam o item e o status (fazer, andamento, bloqueada ou feita)" };
      return { frame: { ...base, itemId: a[0], status, ...(a[2] ? { evidence: a[2] } : {}) } };
    }
    case "item_delete":
      return a[0] ? { frame: { ...base, itemId: a[0] } } : { error: "falta o item" };
    case "project_update": {
      if (!a[0] && !a[1]) return { error: "falta o briefing ou as instruções" };
      return { frame: { ...base, ...(a[0] ? { briefing: a[0] } : {}), ...(a[1] ? { instructions: a[1] } : {}) } };
    }
    case "source_add":
      return a[0] && a[1] ? { frame: { ...base, source: { title: a[0], content: a[1], kind: "text" } } } : { error: "faltam título e conteúdo da fonte" };
    case "routine_link":
      return a[0] && a[1] ? { frame: { ...base, deviceId: a[0], routineId: a[1], name: a[2] || a[1] } } : { error: "faltam o PC e a rotina" };
    case "routine_unlink":
      return a[0] && a[1] ? { frame: { ...base, deviceId: a[0], routineId: a[1] } } : { error: "faltam o PC e a rotina" };
    case "memory_add": {
      // lembrar("texto", "categoria", "projeto" | "global")
      if (!a[0]) return { error: "falta o que lembrar" };
      const category = pick(CATEGORY_ALIAS, a[1]) ?? "fact";
      const wantsProject = /^proj/i.test(a[2] ?? "") || (!a[2] && Boolean(projectId));
      return { frame: { t: "project", op, text: a[0], category, ...(wantsProject && projectId ? { projectId } : {}) } };
    }
    default:
      return { error: "comando desconhecido" };
  }
}

function summarize(op, reply) {
  switch (op) {
    case "item_upsert": {
      const item = reply?.item;
      if (item?.status === "proposed") return `Deixei como proposta: «${text(item.title, 80)}». Você aprova na aba Acompanhamento do projeto.`;
      return `Registrei «${text(item?.title, 80)}» no projeto.`;
    }
    case "item_status":
      return `Atualizei «${text(reply?.item?.title, 80)}» (${text(reply?.item?.status, 20)}).`;
    case "item_delete":
      return reply?.ok === false ? "Esse item não existe mais." : "Item excluído do projeto.";
    case "project_update":
      return "Atualizei o briefing do projeto.";
    case "source_add":
      return "Guardei a fonte no projeto.";
    case "routine_link":
      return "Liguei a rotina ao projeto.";
    case "routine_unlink":
      return "Desliguei a rotina do projeto.";
    case "memory_add":
      return reply?.memory?.projectId ? "Guardei na memória do projeto." : "Guardei na sua memória.";
    default:
      return "Pronto.";
  }
}

const ERROR_TEXT = {
  needs_approval: "Precisa da sua aprovação neste projeto, então não mexi.",
  proactivity_off: "A proatividade deste projeto está desligada, então não mexi.",
  forbidden: "Esse projeto não permite isso.",
  not_found: "Não encontrei isso no projeto.",
  bad_request: "Os dados do comando estavam incompletos.",
};

/**
 * Aplica um comando da Teto no hub e devolve, em texto, o que realmente houve (a Teto nunca deve contar o que não
 * aconteceu: o hub pode propor, recusar ou pedir aprovação).
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function applyProjectAction(action, { threadId } = {}) {
  const spec = PROJECT_COMMANDS[String(action?.command ?? "").toLowerCase()];
  if (!spec) return { ok: false, text: "Não entendi o comando de projeto. Nada foi alterado." };
  const projectId = projectOfThread(threadId);
  if (spec.needsProject && !projectId) {
    return { ok: false, text: "Isso só funciona dentro de um projeto (abra a conversa do projeto). Nada foi alterado." };
  }
  const built = buildProjectFrame(spec.op, action.args, { projectId });
  if ("error" in built) return { ok: false, text: `Não consegui: ${built.error}. Nada foi alterado.` };
  if (!isHubProjectsAvailable()) return { ok: false, text: "Não consegui falar com os projetos agora (o hub está fora do ar). Nada foi alterado." };
  try {
    const reply = await link.request(built.frame, CALL_TIMEOUT_MS);
    return { ok: true, text: summarize(spec.op, reply) };
  } catch (err) {
    const code = typeof err?.code === "string" ? err.code : "";
    return { ok: false, text: `${ERROR_TEXT[code] ?? `Não consegui: ${text(err?.message, 160) || "erro do hub"}.`} Nada foi alterado.` };
  }
}

/** Bloco de prompt: o contexto vindo do hub e a sintaxe dos comandos; vazio quando o hub não mandou nada. */
export function formatHubContextBlock(ctx) {
  if (!ctx || (!ctx.contextText && !ctx.projectId)) return [];
  const lines = ["[MEMÓRIA E PROJETO DO USUÁRIO — vem do hub da conta]"];
  if (ctx.contextText) lines.push(ctx.contextText);
  lines.push(
    "Use essa memória naturalmente; não a recite nem diga que 'consultou o hub'. Se algo ali estiver desatualizado ou o usuário corrigir, grave de novo com lembrar(...).",
    "Comandos (argumento vazio = \"\"; ids vêm da lista de itens acima):",
    '- lembrar("o que lembrar", "fato|preferencia|episodio", "global|projeto") — guarda na memória. Só fatos duráveis e úteis; nada sensível (senhas, documentos).',
  );
  if (ctx.projectId) {
    lines.push(
      '- itemProjeto("tarefa|spec|decisao", "título", "detalhe", "usuario|teto", "prazo ISO", "diario|semanal|mensal", "HH:MM", "id para editar") — propõe/edita um item. O que você cria vira PROPOSTA até o usuário aprovar.',
      '- statusItem("id", "fazer|andamento|bloqueada|feita", "evidência") — muda o estado (nas tarefas do usuário, só com ele pedindo/confirmando).',
      '- excluirItem("id") — pode exigir aprovação do usuário.',
      '- atualizarProjeto("briefing", "instruções") — reescreve o briefing/instruções do projeto.',
      '- fonteProjeto("título", "conteúdo") — guarda um texto como fonte de consulta.',
      '- ligarRotina("deviceId", "routineId", "nome") / desligarRotina("deviceId", "routineId").',
      "REGRAS: o hub decide se o comando vale e o sistema avisa o resultado na conversa — NÃO diga que registrou/concluiu antes disso. Respeite o nível de proatividade descrito no projeto.",
    );
  }
  return lines;
}

/** Turno aberto pelo hub (tarefa da IA no prazo, ajuda numa tarefa do usuário, resultado de rotina). Não é fala do usuário. */
export function buildProjectEventPrompt(frame) {
  const item = frame?.item ?? {};
  const header = {
    task_due: `[EVENTO DO SISTEMA — tarefa SUA do projeto venceu: «${text(item.title, 120)}» (id ${text(item.id, 80)})]`,
    task_help: `[EVENTO DO SISTEMA — tarefa do USUÁRIO perto do prazo: «${text(item.title, 120)}» (id ${text(item.id, 80)}), até ${text(item.dueAt, 40) || "?"}]`,
    routine_result: `[EVENTO DO SISTEMA — rotina do projeto terminou: «${text(frame?.routine?.name, 120)}» (${text(frame?.routine?.status, 20)})]`,
  }[frame?.t];
  if (!header) return null;
  const body = [header, text(item.detail, 800)];
  if (frame.t === "routine_result") {
    body.push(text(frame.routine?.output, 1200), text(frame.routine?.error, 400));
  }
  body.push("");
  if (frame.t === "task_due") {
    body.push(
      "O hub abriu este turno sozinho (o usuário não escreveu nada). Faça a tarefa: se for com o computador use computador(...)" +
        (frame.requireApprovalForPc ? ", MAS este projeto exige aprovação antes de agir no PC — então peça a aprovação ao usuário em vez de executar." : "."),
      'Ao terminar (ou se não der), registre com statusItem("id", "feita|bloqueada", "o que foi feito") e responda com 1–2 frases.',
    );
  } else if (frame.t === "task_help") {
    body.push(
      "O hub abriu este turno sozinho. Avise o usuário, de forma curta e amigável, que a tarefa está perto do prazo e sugira COMO fazer, com base na memória e nas fontes do projeto. Não marque como feita e não execute nada.",
    );
  } else {
    body.push(
      "Resuma o resultado em 1–2 frases. Se falhou, diga o provável motivo e sugira o próximo passo; se fizer sentido, proponha uma tarefa com itemProjeto(...). Não execute nada no computador.",
    );
  }
  body.push("- NÃO agradeça nem responda como se o usuário tivesse escrito.");
  return [...body.filter((l) => l !== undefined && l !== null)].filter((l, i, arr) => l !== "" || arr[i - 1] !== "").join("\n");
}
