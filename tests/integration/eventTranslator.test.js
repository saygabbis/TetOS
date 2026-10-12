import { describe, expect, it, beforeAll } from "vitest";
import { registerAutomateRun } from "../../src/integrations/automate/automateRunContext.js";
import { translateAutomateNotification } from "../../src/integrations/automate/eventTranslator.js";

describe("eventTranslator", () => {
  beforeAll(() => {
    registerAutomateRun({
      instructionId: "inst-1",
      runId: "run-et-1",
      threadId: "thread-et-1",
    });
  });

  it("traduz tool_call start", () => {
    const events = translateAutomateNotification("notifications/automate/tool_call", {
      instructionId: "inst-1",
      tool: "window_list",
      status: "start",
      turnId: "t1",
    });
    expect(events[0].type).toBe("plan.step");
    expect(events[0].step.state).toBe("running");
  });

  it("emite utterance em user_feedback e tool_call de resposta", () => {
    const direct = translateAutomateNotification("notifications/automate/user_feedback", {
      instructionId: "inst-1",
      message: "Pronto, abri o Bloco de Notas.",
    });
    expect(direct[0]).toMatchObject({
      type: "tool.log",
      stepId: "utterance:user_feedback",
      line: "Pronto, abri o Bloco de Notas.",
    });

    const viaTool = translateAutomateNotification("notifications/automate/tool_call", {
      instructionId: "inst-1",
      tool: "user_feedback",
      status: "done",
      args: { message: "Tudo certo." },
    });
    expect(viaTool.some((e) => e.stepId === "utterance:user_feedback")).toBe(true);
  });

  it("traduz clarification em permission.request e utterance ask_user", () => {
    const events = translateAutomateNotification("notifications/automate/clarification_needed", {
      instructionId: "inst-1",
      id: "p1",
      question: "Confirmar?",
    });
    expect(events.some((e) => e.type === "permission.request")).toBe(true);
    expect(events.some((e) => e.stepId === "utterance:ask_user:p1" && e.line === "Confirmar?")).toBe(true);
    expect(events.find((e) => e.type === "permission.request").request.input).toBeUndefined();
  });

  const permissionFor = (question) =>
    translateAutomateNotification("notifications/automate/clarification_needed", {
      instructionId: "inst-1",
      id: "p2",
      questions: [question],
    }).find((e) => e.type === "permission.request").request;

  it("pergunta aberta (free_text) pede texto, não Confirmar/Negar", () => {
    const request = permissionFor({ prompt: "O que adiciono nele?", type: "free_text" });
    expect(request.question).toBe("O que adiciono nele?");
    expect(request.input).toBe("text");
    expect(request.options).toBeUndefined();
  });

  it("escolha vira chips com os ids reais das opções", () => {
    const request = permissionFor({
      prompt: "AÇÃO DESTRUTIVA — aprovar?",
      type: "single_choice",
      options: [{ id: "approve", label: "Aprovar" }, { id: "deny", label: "Negar" }],
    });
    expect(request.input).toBe("choice");
    expect(request.options).toEqual([{ id: "approve", label: "Aprovar" }, { id: "deny", label: "Negar" }]);
    expect(request.multiple).toBeUndefined();
    expect(permissionFor({ prompt: "Quais?", type: "multiple_choice", options: [{ id: "a", label: "A" }] }).multiple).toBe(true);
  });
});
