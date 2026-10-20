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

import { beginEnqueue, endEnqueue, resolveAutomateRun as resolveRun } from "../../src/integrations/automate/automateRunContext.js";

describe("evento do PC antes do register", () => {
  it("id desconhecido durante um enfileiramento em andamento é desse run", () => {
    beginEnqueue("run-early-1", "wa:5511@s.whatsapp.net");
    expect(resolveRun({ instructionId: "instr-early-xyz" })).toMatchObject({ runId: "run-early-1", threadId: "wa:5511@s.whatsapp.net" });
    // depois de reivindicado, continua resolvendo pelo instructionId
    expect(resolveRun({ instructionId: "instr-early-xyz" })?.runId).toBe("run-early-1");
    endEnqueue("run-early-1");
  });
  it("sem enfileiramento em andamento, id desconhecido continua null", () => {
    expect(resolveRun({ instructionId: "instr-nada" })).toBeNull();
  });
});
