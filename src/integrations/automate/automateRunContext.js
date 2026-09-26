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

  if (instructionId) {
    const recent = lastClientAutomateRun;
    if (recent && Date.now() - recent.at < 120_000) {
      return {
        runId: clientFromThread ?? recent.runId,
        threadId: threadFromParam ?? recent.threadId,
        instructionId,
      };
    }
  }

  const recent = lastClientAutomateRun;
  const fallbackRunId = params.turnId ?? "run-active";
  const threadId =
    threadFromParam ??
    resolveThreadIdForRun(clientFromThread) ??
    recent?.threadId ??
    null;
  const runId =
    clientFromThread ??
    (instructionId && recent && Date.now() - recent.at < 120_000 ? recent.runId : null) ??
    (recent && Date.now() - recent.at < 120_000 ? recent.runId : null) ??
    fallbackRunId;

  return {
    runId,
    threadId: threadId ?? recent?.threadId ?? "thread-1",
    instructionId,
  };
}

export function clearAutomateRun(instructionId) {
  if (instructionId) byInstructionId.delete(instructionId);
}
