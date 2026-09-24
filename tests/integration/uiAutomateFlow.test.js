import { describe, expect, it } from "vitest";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";
import {
  registerAutomateRun,
  resolveAutomateRun,
} from "../../src/integrations/automate/automateRunContext.js";
import { translateAutomateNotification } from "../../src/integrations/automate/eventTranslator.js";

describe("fluxo UI + AutoMate", () => {
  it("parse computador() gera ação automate", () => {
    const actions = parseActionCommands('mensagem("ok")\ncomputador("abrir o Chrome")');
    expect(actions.some((a) => a.type === "automate" && a.intent === "abrir o Chrome")).toBe(true);
  });

  it("tradutor usa runId registrado por instructionId", () => {
    registerAutomateRun({
      instructionId: "inst-abc",
      runId: "run-xyz",
      threadId: "thread-9",
    });
    const ctx = resolveAutomateRun({ instructionId: "inst-abc" });
    expect(ctx.runId).toBe("run-xyz");
    expect(ctx.threadId).toBe("thread-9");

    const events = translateAutomateNotification("notifications/automate/tool_call", {
      instructionId: "inst-abc",
      tool: "window_list",
      status: "start",
      turnId: "t1",
    });
    expect(events[0].runId).toBe("run-xyz");
    expect(events[0].type).toBe("plan.step");
  });

  it("clarification manual vira control.request", () => {
    const events = translateAutomateNotification("notifications/automate/clarification_needed", {
      id: "c1",
      kind: "manual_action",
      questions: [{ prompt: "Clique em Permitir" }],
      instructionId: "inst-1",
    });
    expect(events[0].type).toBe("control.request");
  });

  it("sequência task_progress + completed com mesmo runId", () => {
    registerAutomateRun({
      instructionId: "inst-seq",
      runId: "run-seq",
      threadId: "thread-1",
    });
    const running = translateAutomateNotification("notifications/automate/task_progress", {
      instructionId: "inst-seq",
      status: "running",
    });
    const done = translateAutomateNotification("notifications/automate/task_completed", {
      instructionId: "inst-seq",
    });
    expect(running[0].runId).toBe("run-seq");
    expect(done[0].runId).toBe("run-seq");
    expect(done[0].status).toBe("completed");
  });
});
