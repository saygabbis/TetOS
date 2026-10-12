import { describe, expect, it } from "vitest";
import {
  bindRunToThread,
  registerAutomateRun,
  resolveAutomateRun,
} from "../../src/integrations/automate/automateRunContext.js";

describe("resolveAutomateRun", () => {
  it("resolve por instructionId registrado", () => {
    registerAutomateRun({
      instructionId: "inst-ctx-registered",
      runId: "run-ctx-1",
      threadId: "thread-ctx-42",
    });
    expect(resolveAutomateRun({ instructionId: "inst-ctx-registered" })).toEqual({
      runId: "run-ctx-1",
      threadId: "thread-ctx-42",
      instructionId: "inst-ctx-registered",
    });
  });

  it("resolve por runId já vinculado à thread", () => {
    bindRunToThread("run-ctx-bound", "thread-ctx-bound");
    expect(resolveAutomateRun({ instructionId: "run-ctx-bound" })).toEqual({
      runId: "run-ctx-bound",
      threadId: "thread-ctx-bound",
      instructionId: "run-ctx-bound",
    });
  });

  it("retorna null sem mapeamento conhecido", () => {
    expect(resolveAutomateRun({ instructionId: "inst-ctx-unknown" })).toBeNull();
    expect(resolveAutomateRun({})).toBeNull();
  });
});
