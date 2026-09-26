import { registerAutomateRun } from "./automateRunContext.js";
import { parseAutomateMention } from "./parseAutomateMention.js";

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
    const parsed = parseAutomateMention(text);
    const goal = (parsed.hasAutomate ? parsed.intentText : String(text ?? "")).trim();
    const args = { text: goal || String(text ?? "").trim() };
    if (Array.isArray(meta.skillNames) && meta.skillNames.length > 0) {
      args.skillNames = meta.skillNames;
    }
    const result = await this.gateway.callTool(deviceId, "automate_enqueue", args);
    const instructionId = parseInstructionFromResult(result);
    if (instructionId) {
      registerAutomateRun({ instructionId, runId, threadId });
    }
    // #region agent log
    const { appendFile } = await import("node:fs/promises");
    void appendFile(
      "C:\\Users\\Administrator\\Desktop\\Kevin\\AutoMate\\.cursor\\debug-9049d4.log",
      `${JSON.stringify({
        sessionId: "9049d4",
        timestamp: Date.now(),
        location: "automateClient.js:enqueue",
        message: "enqueue result",
        hypothesisId: "A",
        data: { runId, instructionId, goalLen: args.text.length },
      })}\n`,
    ).catch(() => undefined);
    // #endregion
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
