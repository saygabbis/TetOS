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

  it("traduz clarification em permission.request", () => {
    const events = translateAutomateNotification("notifications/automate/clarification_needed", {
      id: "p1",
      question: "Confirmar?",
    });
    expect(events[0].type).toBe("permission.request");
  });
});
