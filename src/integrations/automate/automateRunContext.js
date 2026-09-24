/** @type {Map<string, { runId: string, threadId: string }>} */
const byInstructionId = new Map();

/** @type {Map<string, string>} */
const threadIdByRunId = new Map();

export function bindRunToThread(runId, threadId) {
  if (!runId || !threadId) return;
  threadIdByRunId.set(runId, threadId);
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
  const runId = instructionId ?? params.turnId ?? "run-active";
  return {
    runId,
    threadId: params.threadId ?? "thread-1",
    instructionId,
  };
}

export function clearAutomateRun(instructionId) {
  if (instructionId) byInstructionId.delete(instructionId);
}
