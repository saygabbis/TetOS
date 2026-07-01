import { describe, expect, it } from "vitest";
import { RESPONSE_MODES, RESPONSE_OUTPUTS } from "../../src/core/pipeline/responseModes.js";
import {
  addDecisionStep,
  createDecisionTrace,
  finalizeDecisionTrace
} from "../../src/infra/observability/decisionTrace.js";

describe("decision trace", () => {
  it("records normalized channel context and final output", () => {
    const trace = createDecisionTrace({
      eventId: "m1",
      source: "test",
      userId: "u1",
      channelId: "c1",
      sessionId: "s1",
      isGroup: true
    });

    addDecisionStep(trace, "identity.resolved", { userId: "u1" });
    expect(trace.channelType).toBe("group");
    expect(trace.steps).toHaveLength(1);

    const logs = [];
    const metrics = [];
    const runtime = {
      defaults: { thinkingLogsEnabled: false },
      logger: { log: (event, payload) => logs.push({ event, payload }) },
      metrics: { increment: (key) => metrics.push(key) }
    };

    const finalTrace = finalizeDecisionTrace(runtime, trace, {
      output: RESPONSE_OUTPUTS.TEXT,
      pipelineMode: RESPONSE_MODES.FULL
    });

    expect(finalTrace.output).toBe(RESPONSE_OUTPUTS.TEXT);
    expect(logs[0].event).toBe("decision.trace");
    expect(metrics[0]).toBe("decision.trace");
  });
});
