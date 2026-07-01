export function createDecisionTrace({
  eventId = null,
  source = "unknown",
  userId = null,
  channelId = null,
  sessionId = null,
  isGroup = false
} = {}) {
  return {
    eventId,
    source,
    userId,
    channelId,
    sessionId,
    channelType: isGroup ? "group" : "dm",
    inputType: null,
    command: null,
    activation: "not_checked",
    groupGate: "not_checked",
    pipelineMode: null,
    output: null,
    steps: [],
    startedAt: new Date().toISOString()
  };
}

export function addDecisionStep(trace, step, detail = {}) {
  if (!trace || !step) return trace;
  trace.steps.push({
    step,
    at: new Date().toISOString(),
    ...detail
  });
  return trace;
}

export function finalizeDecisionTrace(runtime, trace, patch = {}) {
  if (!trace) return null;
  const finalTrace = {
    ...trace,
    ...patch,
    finishedAt: new Date().toISOString()
  };
  runtime?.logger?.log?.("decision.trace", finalTrace);
  runtime?.metrics?.increment?.("decision.trace");
  if (runtime?.defaults?.thinkingLogsEnabled) {
    console.log(`[decision.trace] ${JSON.stringify(finalTrace)}`);
  }
  return finalTrace;
}
