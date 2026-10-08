export const USER_FACING_AUTOMATE_TOOLS = new Set([
  "user_feedback",
  "notify",
  "verify_result",
  "ask_user",
  "request_user_takeover",
]);

function pickString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export function emitUtteranceLog(runId, channel, text, level = "info", idSuffix = "") {
  const line = String(text ?? "").trim();
  if (!line) return null;
  const lvl = level === "error" || level === "warn" ? level : "info";
  const stepId = idSuffix ? `utterance:${channel}:${idSuffix}` : `utterance:${channel}`;
  return {
    type: "tool.log",
    runId,
    stepId,
    line,
    level: lvl,
    at: new Date().toISOString(),
  };
}

export function textFromToolCall(tool, params) {
  const args = params?.args && typeof params.args === "object" ? params.args : {};
  const output = typeof params?.output === "string" ? params.output : "";
  if (tool === "user_feedback" || tool === "notify") {
    return pickString(args.message, args.text, args.content, output);
  }
  if (tool === "ask_user") {
    return pickString(args.prompt, args.question, args.message, output);
  }
  if (tool === "request_user_takeover") {
    return pickString(args.reason, args.message, args.instructions, output);
  }
  if (tool === "verify_result") {
    return pickString(args.observed, args.message, output);
  }
  return pickString(output);
}

export function isUtteranceStepId(stepId) {
  return typeof stepId === "string" && stepId.startsWith("utterance:");
}

export function utteranceChannelFromStepId(stepId) {
  const rest = stepId.slice("utterance:".length);
  const channel = rest.split(":")[0];
  return USER_FACING_AUTOMATE_TOOLS.has(channel) ? channel : rest;
}
