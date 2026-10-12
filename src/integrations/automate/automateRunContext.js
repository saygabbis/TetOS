import { EventEmitter } from "node:events";

/**
 * Execuções que a IA (Teto) pediu ao AutoMate. Quando uma delas termina, o resultado volta para a IA explicar ao
 * usuário (`automateOutcomes` emite `outcome`). Execuções pedidas direto pelo usuário (@automate) não entram aqui.
 */
export const automateOutcomes = new EventEmitter();

/** @type {Map<string, { intent: string, at: number }>} */
const explainRuns = new Map();
const MAX_EXPLAIN_RUNS = 200;

export function markRunForExplanation(runId, intent) {
  if (!runId) return;
  explainRuns.set(runId, { intent: String(intent ?? "").slice(0, 300), at: Date.now() });
  if (explainRuns.size > MAX_EXPLAIN_RUNS) {
    const oldest = [...explainRuns.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) explainRuns.delete(oldest[0]);
  }
}

/** Avisa que a execução terminou (uma vez só). Devolve se alguém precisa explicar o resultado ao usuário. */
export function reportAutomateOutcome({ runId, threadId, status, output, error }) {
  const entry = runId ? explainRuns.get(runId) : null;
  if (!entry) return false;
  explainRuns.delete(runId);
  automateOutcomes.emit("outcome", {
    runId,
    threadId,
    status,
    output: output ? String(output) : "",
    error: error ? String(error) : "",
    intent: entry.intent,
  });
  return true;
}

/** @type {Map<string, { runId: string, threadId: string }>} */
const byInstructionId = new Map();

/** @type {Map<string, string>} */
const threadIdByRunId = new Map();

/** @type {Map<string, string>} */
const clientRunIdByThread = new Map();

/** Último run cliente (run-*) enfileirado pela UI — mapeia instructionId antes do register. */
let lastClientAutomateRun = null;

export function bindRunToThread(runId, threadId) {
  if (!runId || !threadId) return;
  threadIdByRunId.set(runId, threadId);
  if (String(runId).startsWith("run-")) {
    clientRunIdByThread.set(threadId, runId);
    lastClientAutomateRun = { runId, threadId, at: Date.now() };
  }
}

export function resolveThreadIdForRun(runId) {
  if (!runId) return null;
  return threadIdByRunId.get(runId) ?? null;
}

export function registerAutomateRun({ instructionId, runId, threadId }) {
  if (!instructionId || !runId || !threadId) return;
  byInstructionId.set(instructionId, { runId, threadId });
  bindRunToThread(runId, threadId);
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

  return null;
}

export function clearAutomateRun(instructionId) {
  if (instructionId) byInstructionId.delete(instructionId);
}
