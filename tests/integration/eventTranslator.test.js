import { describe, expect, it } from "vitest";
import { translateAutomateNotification } from "../../src/integrations/automate/eventTranslator.js";

describe("eventTranslator", () => {
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
    const perm = events.find((e) => e.type === "permission.request");
    expect(perm.request).toMatchObject({ id: "p1", question: "Confirmar?", input: "text" });
  });

  it("aprovação manda a opção approve e takeover manda done", () => {
    const approval = translateAutomateNotification("notifications/automate/clarification_needed", {
      id: "a1",
      kind: "approval",
      questions: [{ prompt: "Apagar?", type: "single_choice", options: [{ id: "approve", label: "Aprovar" }, { id: "deny", label: "Negar" }] }],
    });
    const perm = approval.find((e) => e.type === "permission.request");
    expect(perm.request.input).toBe("approval");
    expect(perm.request.options.map((o) => o.id)).toEqual(["approve", "deny"]);

    const takeover = translateAutomateNotification("notifications/automate/clarification_needed", {
      id: "t1",
      kind: "takeover",
      questions: [{ prompt: "Faça login" }],
    });
    const ctrl = takeover.find((e) => e.type === "control.request");
    expect(ctrl.request.input).toBe("takeover");
    expect(ctrl.request.options.map((o) => o.id)).toEqual(["done", "refuse"]);
  });
});
