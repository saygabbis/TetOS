import { registerAutomateRun } from "./automateRunContext.js";

function parseInstructionFromResult(result) {
  const content = result?.content;
  if (!Array.isArray(content) || !content[0]?.text) return null;
  try {
    const parsed = JSON.parse(content[0].text);
    return parsed?.id ?? parsed?.instructionId ?? null;
  } catch {
    return null;
  }
}

export class AutomateClient {
  constructor(deviceGateway, defaultDeviceId = process.env.TETOS_DEFAULT_DEVICE_ID ?? "default-device") {
    this.gateway = deviceGateway;
    this.defaultDeviceId = defaultDeviceId;
  }

  async enqueue(text, deviceId = this.defaultDeviceId, meta = {}) {
    const runId = meta.runId ?? `run-${Date.now()}`;
    const threadId = meta.threadId ?? "thread-1";
    const result = await this.gateway.callTool(deviceId, "automate_enqueue", { text });
    const instructionId = parseInstructionFromResult(result);
    if (instructionId) {
      registerAutomateRun({ instructionId, runId, threadId });
    }
    return result;
  }

  async answer(clarificationId, answers, deviceId = this.defaultDeviceId) {
    const normalized =
      typeof answers === "object" && answers !== null
        ? answers
        : { q1: String(answers ?? "") };
    return this.gateway.callTool(deviceId, "automate_answer", {
      clarificationId,
      answers: normalized,
    });
  }

  async interrupt(deviceId = this.defaultDeviceId) {
    return this.gateway.callTool(deviceId, "automate_interrupt", {});
  }
}
