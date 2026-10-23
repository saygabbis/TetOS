/**
 * Objetivos, tarefas e agenda do usuário (aba Objetivos do app), guardados no hub. O hub anuncia a ferramenta da
 * conta `organizer` no `ready` e manda o snapshot em cada `message`; a Teto lê o estado pelo prompt e age com
 * comandos de texto (`tarefa(...)`, `concluirTarefa(...)`…) que viram `organizer` / `command` no hub. As permissões,
 * as decisões pendentes e a evidência de conclusão são do hub; aqui só se repassa e se conta o que realmente houve.
 */

const TOOL_NAME = "organizer";
const CALL_TIMEOUT_MS = 20_000;
const MAX_GOALS = 8;
const MAX_TASKS = 15;
const MAX_EVENTS = 8;
const MAX_DECISIONS = 5;

/** @type {{ isReady: () => boolean, request: (frame: object, timeoutMs?: number) => Promise<any> } | null} */
let link = null;
/** @type {Array<{ name: string }>} */
let accountTools = [];
/** @type {any} */
let snapshot = null;

export function setHubOrganizerLink(next) {
  link = next ?? null;
}

/** Hub desconectou: sem o link, a Teto não oferece nem promete nada de Objetivos. */
export function resetHubOrganizer() {
  link = null;
  accountTools = [];
  snapshot = null;
}

/** `ready` e `message` do hub: ferramentas da conta e, nas mensagens, o snapshot atual. */
export function updateHubOrganizerFromFrame(frame, { replace = false } = {}) {
  if (replace) {
    accountTools = [];
    snapshot = null;
  }
  if (Array.isArray(frame?.accountTools)) {
    accountTools = frame.accountTools.filter((t) => t && typeof t.name === "string");
  }
  if (frame?.organizer && typeof frame.organizer === "object") snapshot = frame.organizer;
}

export function isHubOrganizerAvailable() {
  return Boolean(link?.isReady() && accountTools.some((t) => t.name === TOOL_NAME));
}

function text(v, max = 200) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function omitEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== "" && v !== undefined && v !== null));
}

/** Rótulos dos comandos que a Teto escreve; a primeira coluna é o nome em minúsculas (o parser baixa a caixa). */
export const ORGANIZER_COMMANDS = {
  objetivo: { op: "goal_propose", label: "objetivo" },
  tarefa: { op: "task_create", label: "tarefa" },
  movertarefa: { op: "task_move", label: "tarefa" },
  concluirtarefa: { op: "task_complete", label: "tarefa" },
  compromisso: { op: "event_create", label: "compromisso" },
};

/**
 * Argumentos posicionais da Teto → comando do hub (`organizer`, action=command). Vazio = omitido.
 * @returns {{ command: object } | { error: string }}
 */
export function buildOrganizerCommand(op, args = []) {
  const a = args.map((v) => text(v, 400));
  switch (op) {
    case "goal_propose": {
      if (!a[0]) return { error: "falta o título do objetivo" };
      return { command: { type: "goal.upsert", goal: omitEmpty({ title: a[0], outcome: a[1], dueAt: a[2] }) } };
    }
    case "task_create": {
      if (!a[1]) return { error: "falta o título da tarefa" };
      const minutes = Number(a[4]);
      return {
        command: {
          type: "task.upsert",
          task: omitEmpty({
            goalId: a[0],
            title: a[1],
            plannedAt: a[2],
            dueAt: a[3],
            durationMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined,
          }),
        },
      };
    }
    case "task_move": {
      if (!a[0] || !a[1]) return { error: "faltam a tarefa e o novo horário" };
      return { command: { type: "task.upsert", task: { id: a[0], plannedAt: a[1] } } };
    }
    case "task_complete": {
      if (!a[0]) return { error: "falta a tarefa" };
      return { command: { type: "task.complete", taskId: a[0], ...omitEmpty({ evidence: a[1] }) } };
    }
    case "event_create": {
      if (!a[1] || !a[2] || !a[3]) return { error: "faltam título, início e fim do compromisso" };
      return { command: { type: "event.upsert", event: omitEmpty({ goalId: a[0], title: a[1], startAt: a[2], endAt: a[3] }) } };
    }
    default:
      return { error: "comando desconhecido" };
  }
}

function parseHubResult(reply) {
  const content = reply?.result?.content;
  const raw = Array.isArray(content) ? content.find((c) => typeof c?.text === "string")?.text : undefined;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Aplica um comando da Teto no hub e devolve o que realmente aconteceu, em texto para o usuário: o hub pode aplicar,
 * guardar como decisão pendente (fora do combinado) ou recusar, e a Teto nunca deve contar o que não houve.
 * @returns {Promise<{ ok: boolean, pending: boolean, text: string }>}
 */
export async function applyOrganizerAction(action, { threadId } = {}) {
  const spec = ORGANIZER_COMMANDS[String(action?.command ?? "").toLowerCase()];
  const built = buildOrganizerCommand(action?.op, action?.args);
  if (!spec || "error" in built) {
    return { ok: false, pending: false, text: `Não consegui mexer nos Objetivos: ${"error" in built ? built.error : "comando inválido"}.` };
  }
  if (!isHubOrganizerAvailable()) {
    return { ok: false, pending: false, text: "Não consegui falar com os Objetivos agora (o hub está fora do ar). Nada foi alterado." };
  }
  try {
    const reply = await link.request(
      { t: "call", tool: TOOL_NAME, args: { action: "command", command: built.command }, ...(threadId ? { threadId } : {}) },
      CALL_TIMEOUT_MS,
    );
    const result = parseHubResult(reply);
    if (result.snapshot) snapshot = result.snapshot;
    if (result.decision) {
      const what = text(result.decision.description, 240);
      return {
        ok: true,
        pending: true,
        text: `Deixei como proposta, ainda não foi aplicado${what ? `: ${what}` : ""}. Você decide em «Preciso de você» na aba Objetivos.`,
      };
    }
    return { ok: true, pending: false, text: `Pronto, ${spec.label} atualizada na aba Objetivos.` };
  } catch (err) {
    return { ok: false, pending: false, text: `Não consegui mexer nos Objetivos: ${text(err?.message, 200) || "erro do hub"}. Nada foi alterado.` };
  }
}

function when(iso) {
  return text(iso, 40) || "—";
}

/** Bloco de prompt: estado atual (do snapshot) e as regras; vazio quando o hub não oferece Objetivos. */
export function formatOrganizerBlock() {
  if (!isHubOrganizerAvailable()) return [];
  const lines = [
    "[OBJETIVOS E AGENDA DO USUÁRIO — aba Objetivos do app]",
    "Comandos (ids vêm da lista abaixo; datas em ISO com fuso, ex. 2026-05-04T09:00:00-03:00; argumento vazio = \"\"):",
    '- tarefa("goalId", "título", "quando (ISO)", "prazo (ISO)", "minutos") — cria um próximo passo; "quando" reserva um bloco na agenda.',
    '- moverTarefa("taskId", "novo horário (ISO)") — reagenda uma tarefa.',
    '- concluirTarefa("taskId", "run:<id da execução>") — só com confirmação do usuário ou evidência de uma execução concluída ligada à tarefa.',
    '- compromisso("goalId", "título", "início (ISO)", "fim (ISO)") — registra um compromisso na agenda.',
    '- objetivo("título", "resultado esperado", "prazo (ISO)") — propõe um objetivo novo (sempre fica para o usuário aprovar).',
    "REGRAS: o hub decide se o comando vale; quem concede autonomia é só o usuário. O sistema avisa o resultado de cada comando na conversa (aplicado, proposta pendente ou erro) — NÃO diga que aplicou nem que concluiu antes disso; diga o que vai tentar. Respeite dias e horários autorizados, compromissos fixos e o horário silencioso. Nunca marque atividade pessoal como concluída sem o usuário confirmar.",
  ];
  const s = snapshot;
  if (!s || typeof s !== "object") {
    lines.push("(O estado dos Objetivos ainda não chegou; não invente ids.)");
    return lines;
  }
  const tz = text(s.settings?.timeZone, 40);
  lines.push(`Fuso: ${tz || "?"}${s.settings?.paused ? " — assistente PAUSADO pelo usuário: não aja por conta própria" : ""}.`);
  const goals = (Array.isArray(s.goals) ? s.goals : []).filter((g) => g.status === "active").slice(0, MAX_GOALS);
  lines.push(goals.length ? "Objetivos ativos:" : "Nenhum objetivo ativo.");
  for (const g of goals) {
    const auto = g.autonomy ?? {};
    const rights = [auto.canPlan ? "planejar" : "", auto.canReschedule ? "reorganizar" : ""].filter(Boolean).join("+") || "sem autonomia (só propõe)";
    const hours = auto.canPlan || auto.canReschedule ? `, dias ${(auto.weekdays ?? []).join("")} das ${text(auto.startHour, 5)} às ${text(auto.endHour, 5)}` : "";
    lines.push(`- ${g.id}: «${text(g.title, 80)}» — ${text(g.outcome, 120) || "sem resultado descrito"}; prazo ${when(g.dueAt)}; ${rights}${hours}`);
  }
  const tasks = (Array.isArray(s.tasks) ? s.tasks : []).filter((t) => t.status === "todo").slice(0, MAX_TASKS);
  if (tasks.length) {
    lines.push("Próximos passos pendentes:");
    for (const t of tasks) lines.push(`- ${t.id} (objetivo ${t.goalId ?? "—"}): «${text(t.title, 80)}» — marcada ${when(t.plannedAt)}, prazo ${when(t.dueAt)}`);
  }
  const now = Date.now();
  const events = (Array.isArray(s.events) ? s.events : [])
    .filter((e) => Date.parse(e.endAt) >= now)
    .sort((x, y) => Date.parse(x.startAt) - Date.parse(y.startAt))
    .slice(0, MAX_EVENTS);
  if (events.length) {
    lines.push("Agenda (próximos):");
    for (const e of events) lines.push(`- ${e.id}: «${text(e.title, 80)}» ${when(e.startAt)} → ${when(e.endAt)}${e.fixed ? " [FIXO: só muda com aprovação]" : ""}`);
  }
  const pending = (Array.isArray(s.decisions) ? s.decisions : []).filter((d) => d.status === "pending").slice(0, MAX_DECISIONS);
  if (pending.length) {
    lines.push("Aguardando o usuário (não aplicadas):");
    for (const d of pending) lines.push(`- ${text(d.description, 140)}`);
  }
  return lines;
}

/** O que a Teto recebe quando o hub abre um acompanhamento agendado: não é fala do usuário. */
export function buildOrganizerReviewPrompt({ goalId, text: hubText } = {}) {
  return [
    `[EVENTO DO SISTEMA — acompanhamento agendado de objetivo${goalId ? ` (${goalId})` : ""}]`,
    text(hubText, 1500),
    "",
    "O hub abriu este turno sozinho (o usuário não escreveu nada). Revise o objetivo pela lista de Objetivos, avance os próximos passos dentro do combinado (autonomia, dias e horários) usando os comandos de Objetivos, e termine com uma mensagem curta: o que pretende adiantar, o que fica para o usuário decidir e o próximo passo.",
    "- NÃO agradeça nem responda como se o usuário tivesse escrito.",
    "- NÃO dispare tarefas no computador (computador(...)) por conta própria neste turno.",
  ]
    .filter(Boolean)
    .join("\n");
}
