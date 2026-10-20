import { describe, expect, it } from "vitest";
import { planFloodAwareGroupSegments } from "../../src/integrations/whatsapp/conversation/groupFloodCoordinator.js";

const call = (userId, pushName, message, ts, extra = {}) => ({ userId, pushName, message, ts, isDirectMention: true, groupAddressKind: "contextual", messageKey: { id: `${userId}-${ts}` }, ...extra });

describe("grupo: várias pessoas chamando ao mesmo tempo", () => {
  it("vira um turno só, com quem disse o quê", () => {
    const plan = planFloodAwareGroupSegments([
      call("a", "Bia", "teto qual sua música favorita?", 1000),
      call("b", "Caio", "teto canta pra gente", 1900),
      call("c", "Gabbis", "teto responde eles kkk", 2600)
    ]);
    expect(plan.segments).toHaveLength(1);
    const seg = plan.segments[0];
    expect(seg.segmentMultiSpeaker).toBe(true);
    expect(seg.message).toContain("[Bia]: teto qual sua música favorita?");
    expect(seg.segmentParts.map((p) => p.userId)).toEqual(["a", "b", "c"]);
  });

  it("chamadas espaçadas e comandos continuam separados", () => {
    const plan = planFloodAwareGroupSegments([
      call("a", "Bia", "teto oi", 1000),
      call("b", "Caio", ".sticker", 1500, { parsedCommand: { command: "sticker" } }),
      call("a", "Bia", "teto e aí", 30_000)
    ]);
    expect(plan.segments).toHaveLength(3);
  });
});

import { takeNextGroupTurn } from "../../src/integrations/whatsapp/conversation/groupFloodCoordinator.js";

describe("fila do grupo", () => {
  it("junta chamadas acumuladas enquanto ela respondia", () => {
    const seg = (userId, pushName, message, ts, extra = {}) => ({ userId, pushName, message, ts, groupPriorityAddress: true, isDirectMention: true, ...extra });
    const { item, rest } = takeNextGroupTurn([
      seg("c", "Gabbis", "teto responde eles kkk", 2600),
      seg("b", "Caio", "teto canta pra gente", 1900),
      seg("x", "Zé", ".sticker", 2000, { parsedCommand: { command: "sticker" } }),
      { userId: "y", message: "conversa alheia", ts: 2100 }
    ]);
    expect(item.segmentMultiSpeaker).toBe(true);
    expect(item.message).toBe("[Caio]: teto canta pra gente\n[Gabbis]: teto responde eles kkk");
    expect(rest.map((r) => r.userId)).toEqual(["x", "y"]);
  });
});
