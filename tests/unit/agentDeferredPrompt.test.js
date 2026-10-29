import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../src/core/agent/agent.js";
import { ShortTermMemory } from "../../src/core/memory/shortTerm.js";
import { LongTermMemory } from "../../src/core/memory/longTerm.js";
import { ContextBuilder } from "../../src/core/memory/contextBuilder.js";
import { DEFAULTS } from "../../src/infra/config/defaults.js";
import { loadCharacter, loadPersonality } from "../../src/core/personality/index.js";

let agent;
let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tetos-deferred-prompt-"));
  const longTerm = new LongTermMemory(join(dir, "long.json"));
  agent = new Agent({
    personality: loadPersonality(DEFAULTS.personalityPath),
    character: loadCharacter(DEFAULTS.characterPath),
    shortTerm: new ShortTermMemory(20, { persistPath: join(dir, "short.json") }),
    longTerm,
    brain: {},
    contextBuilder: new ContextBuilder(longTerm)
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const prompt = (heldMinutes) =>
  String(agent.buildPrompt("oi", { longTerm: [], mediumTerm: [] }, { sessionId: "t", deferredCatchUp: { reason: "partial", activity: "almoçando", heldMinutes } }));

describe("mensagem que ela viu um pouco depois", () => {
  it("segundos/poucos minutos: não houve demora — nada de 'vi agora, tava almoçando'", () => {
    const p = prompt(0);
    expect(p).toContain("[RESPONDENDO NA HORA]");
    expect(p).toMatch(/NÃO houve demora/);
    expect(p).not.toContain("[VOCÊ SÓ VIU AGORA]");
  });

  it("uns minutos: pode citar o que fazia, sem pedir desculpa", () => {
    const p = prompt(12);
    expect(p).toContain("[VIU UNS MINUTOS DEPOIS]");
    expect(p).toMatch(/sem pedir desculpa/);
  });

  it("demora de verdade: pode dizer que só viu agora", () => {
    expect(prompt(45)).toContain("[VOCÊ SÓ VIU AGORA]");
  });
});
