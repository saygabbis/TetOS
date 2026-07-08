import { describe, expect, it } from "vitest";
import {
  detectDatingProposal,
  detectFlirtTowardTeto,
  detectLoveDeclaration,
  detectMarriageProposal,
  inferRelationshipAdvance,
  relationshipStatusLabel
} from "../../src/core/social/relationshipIntent.js";

describe("relationship intent detection", () => {
  it("detects dating and marriage proposals", () => {
    expect(detectDatingProposal("namora comigo teto")).toBe(true);
    expect(detectMarriageProposal("casa comigo?")).toBe(true);
  });

  it("detects love declarations", () => {
    expect(detectLoveDeclaration("eu te amo")).toBe(true);
    expect(detectLoveDeclaration("te amo como amigo")).toBe(false);
  });

  it("detects flirt toward teto from strangers", () => {
    expect(detectFlirtTowardTeto("namora comigo", { isGroup: false })).toBe(true);
    expect(detectFlirtTowardTeto("teto você é linda")).toBe(true);
  });

  it("infers advance when bonded", () => {
    const adv = inferRelationshipAdvance("namora comigo", {
      trustBond: { intimacy: 0.5, trust: 0.5 },
      isPartner: false
    });
    expect(adv?.target).toBe("dating");
  });

  it("labels status in portuguese", () => {
    expect(relationshipStatusLabel("married")).toBe("casada");
    expect(relationshipStatusLabel("dating")).toBe("namorando");
  });
});
