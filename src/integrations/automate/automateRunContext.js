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
