import { EventEmitter } from "node:events";
import { normalizeArtifactRefs } from "./automateRunsContext.js";

/**
 * Execuções do AutoMate nesta conversa (pedidas pela Teto ou pelo usuário com @automate). Quando uma delas termina,
 * o resultado volta para a IA explicar ao usuário (`automateOutcomes` emite `outcome`).
 */
export const automateOutcomes = new EventEmitter();

/** @type {Map<string, { intent: string, at: number, fromUser: boolean }>} */
const explainRuns = new Map();
const MAX_EXPLAIN_RUNS = 200;

export function markRunForExplanation(runId, intent, { fromUser = false } = {}) {
  if (!runId) return;
  explainRuns.set(runId, { intent: String(intent ?? "").slice(0, 300), at: Date.now(), fromUser: Boolean(fromUser) });
  if (explainRuns.size > MAX_EXPLAIN_RUNS) {
    const oldest = [...explainRuns.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) explainRuns.delete(oldest[0]);
  }
}

/** Avisa que a execução terminou (uma vez só). Devolve se alguém precisa explicar o resultado ao usuário. */
export function reportAutomateOutcome({ runId, threadId, status, output, error, artifacts }) {
  const entry = runId ? explainRuns.get(runId) : null;
  if (!entry) return false;
  explainRuns.delete(runId);
  const refs = normalizeArtifactRefs(artifacts);
  automateOutcomes.emit("outcome", {
    runId,
    threadId,
    status,
    output: output ? String(output) : "",
    error: error ? String(error) : "",
    ...(refs.length ? { artifacts: refs } : {}),
    intent: entry.intent,
    fromUser: entry.fromUser,
  });
  return true;
}

/** @type {Map<string, { runId: string, threadId: string }>} */
const byInstructionId = new Map();

/** @type {Map<string, string>} */
const threadIdByRunId = new Map();

/** @type {Map<string, string>} */
const clientRunIdByThread = new Map();

/**
 * Enfileiramentos em andamento: o PC pode mandar eventos (até o "concluído") antes de a resposta do
 * automate_enqueue chegar com o instructionId. Enquanto houver UM em andamento, o id desconhecido é dele.
 */
const pendingEnqueues = [];
const PENDING_TTL_MS = 15_000;
const MAX_TRACKED = 500;

const capMap = (map) => {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
};

export function beginEnqueue(runId, threadId) {
  if (!runId || !threadId) return;
  pendingEnqueues.push({ runId, threadId, at: Date.now() });
}

export function endEnqueue(runId) {
  const i = pendingEnqueues.findIndex((p) => p.runId === runId);
  if (i >= 0) pendingEnqueues.splice(i, 1);
}

export function bindRunToThread(runId, threadId) {
  if (!runId || !threadId) return;
  threadIdByRunId.set(runId, threadId);
  if (String(runId).startsWith("run-")) clientRunIdByThread.set(threadId, runId);
  capMap(threadIdByRunId);
  capMap(clientRunIdByThread);
}

export function resolveThreadIdForRun(runId) {
  if (!runId) return null;
  return threadIdByRunId.get(runId) ?? null;
}

export function registerAutomateRun({ instructionId, runId, threadId }) {
  if (!instructionId || !runId || !threadId) return;
  byInstructionId.set(instructionId, { runId, threadId });
  capMap(byInstructionId);
  bindRunToThread(runId, threadId);
  endEnqueue(runId);
}

/**
 * Resolve run/thread conhecidos desta instância TetOS.
 * @returns {{ runId: string, threadId: string, instructionId?: string | null } | null}
 */
export function resolveAutomateRun(params = {}) {
  const instructionId = params.instructionId ?? null;
  if (instructionId && byInstructionId.has(instructionId)) {
    return { ...byInstructionId.get(instructionId), instructionId };
  }

  const threadFromParam = params.threadId ?? null;
  const clientFromThread =
    threadFromParam && clientRunIdByThread.has(threadFromParam)
      ? clientRunIdByThread.get(threadFromParam)
      : null;

  const runKey = params.runId ?? instructionId;
  if (runKey) {
    const threadFromRun = resolveThreadIdForRun(runKey);
    if (threadFromRun) {
      return { runId: runKey, threadId: threadFromRun, instructionId };
    }
  }

  if (clientFromThread) {
    const threadId = threadFromParam ?? resolveThreadIdForRun(clientFromThread);
    if (threadId) {
      return { runId: clientFromThread, threadId, instructionId };
    }
  }

  // Evento chegou antes do register: se há exatamente um enfileiramento recente em andamento, é dele.
  if (instructionId) {
    const fresh = pendingEnqueues.filter((p) => Date.now() - p.at <= PENDING_TTL_MS);
    if (fresh.length === 1) {
      const [claim] = fresh;
      byInstructionId.set(instructionId, { runId: claim.runId, threadId: claim.threadId });
      endEnqueue(claim.runId);
      return { runId: claim.runId, threadId: claim.threadId, instructionId };
    }
  }

  return null;
}
