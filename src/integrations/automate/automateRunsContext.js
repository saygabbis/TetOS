/**
 * O que a Teto sabe sobre o AutoMate numa conversa do app: as execuções (em andamento e recentes) e os anexos que o
 * AutoMate entregou. Tudo em poucas linhas e só com metadados: o conteúdo (prints, arquivos) fica no hub e o app o mostra
 * no cartão da tarefa, então a IA nunca recebe base64 nem arquivo.
 */

const MAX_RUNS = 5;
const MAX_ARTIFACTS = 8;
const STATUS_LABEL = { queued: "na fila", running: "em andamento", completed: "concluída", failed: "falhou", stopped: "interrompida" };

function text(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Execuções que o hub manda junto da mensagem (`runs`): só os campos usados, com tamanho limitado. */
export function normalizeAutomateRuns(raw) {
  if (!Array.isArray(raw)) return [];
  const runs = [];
  for (const r of raw.slice(-MAX_RUNS)) {
    const title = text(r?.title, 120);
    if (!title) continue;
    runs.push({
      title,
      status: text(r?.status, 20) || "running",
      deviceName: text(r?.deviceName, 60) || null,
      startedAt: text(r?.startedAt, 40),
      ...(text(r?.endedAt, 40) ? { endedAt: text(r.endedAt, 40) } : {}),
      ...(text(r?.error, 160) ? { error: text(r.error, 160) } : {}),
      ...(text(r?.output, 200) ? { output: text(r.output, 200) } : {}),
    });
  }
  return runs;
}

function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
}

/** Bloco de prompt com as execuções da conversa (vazio se não há nenhuma: não gasta contexto). */
export function formatAutomateRunsBlock(runs) {
  const list = normalizeAutomateRuns(runs);
  if (!list.length) return [];
  return [
    "[EXECUÇÕES DO AUTOMATE NESTA CONVERSA]",
    ...list.map((r) => {
      const pc = r.deviceName ? ` no PC "${r.deviceName}"` : "";
      const when = r.endedAt ? ` (${clock(r.endedAt)})` : r.startedAt ? ` (desde ${clock(r.startedAt)})` : "";
      const err = r.status === "failed" && r.error ? `: ${r.error}` : "";
      const out = r.output ? ` — respondeu: ${r.output}` : "";
      return `- «${r.title}» — ${STATUS_LABEL[r.status] ?? r.status}${pc}${when}${err}${out}`;
    }),
    "Se o usuário perguntar do andamento, responda com isso; não abra uma tarefa nova só para olhar.",
  ];
}

/** O que está na fila ou rodando agora em outras conversas/PCs da conta (o hub manda como `activeRuns`). */
export function formatActiveRunsBlock(runs) {
  const list = normalizeAutomateRuns(Array.isArray(runs) ? runs.slice(0, 10) : []);
  if (!list.length) return [];
  return [
    "[RODANDO AGORA EM OUTRAS CONVERSAS]",
    ...list.map((r) => {
      const pc = r.deviceName ? ` no PC "${r.deviceName}"` : "";
      const since = r.startedAt ? ` (desde ${clock(r.startedAt)})` : "";
      return `- «${r.title}» — ${STATUS_LABEL[r.status] ?? r.status}${pc}${since}`;
    }),
    "Se o usuário perguntar o que o computador está fazendo, considere também estas; tarefa nova no mesmo PC entra na fila depois delas.",
  ];
}

/** Anexos de uma execução como referências (id, nome, tipo, tamanho, legenda). Qualquer `data` (conteúdo) é descartado. */
export function normalizeArtifactRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw.slice(0, MAX_ARTIFACTS)) {
    const name = text(a?.name, 120);
    if (!name || (a?.kind !== "image" && a?.kind !== "file")) continue;
    out.push({
      kind: a.kind,
      name,
      size: Number.isFinite(a.size) && a.size >= 0 ? Math.round(a.size) : 0,
      ...(text(a?.caption, 160) ? { caption: text(a.caption, 160) } : {}),
    });
  }
  return out;
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1).replace(".", ",")} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Linhas do prompt de resultado com os anexos da tarefa (vazio se não há). */
export function formatArtifactsLines(artifacts) {
  const list = normalizeArtifactRefs(artifacts);
  if (!list.length) return [];
  return [
    "Anexos desta tarefa (já aparecem no cartão do app, onde o usuário vê e baixa, inclusive no celular — você NÃO reenvia o conteúdo):",
    ...list.map((a) => `- ${a.name} (${a.kind === "image" ? "imagem" : "arquivo"}${a.size ? `, ${formatSize(a.size)}` : ""})${a.caption ? ` — legenda: ${a.caption}` : ""}`),
    "Cite-os pelo nome e comente só o que a resposta do AutoMate permite afirmar; você não viu o conteúdo, então não o invente.",
  ];
}
