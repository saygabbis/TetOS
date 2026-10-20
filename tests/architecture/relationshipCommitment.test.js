import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelationshipCommitmentStore } from "../../src/core/social/RelationshipCommitmentStore.js";

describe("relationship commitment store", () => {
  let tmpDir;
  let storePath;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tetos-rel-"));
    storePath = join(tmpDir, "relationshipState.json");
    store = new RelationshipCommitmentStore(storePath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts single", () => {
    expect(store.getState().status).toBe("single");
    expect(store.isCommitted()).toBe(false);
  });

  it("advances to dating and blocks others", () => {
    const first = store.advance("dm-user-a", "dating", { displayName: "Ana", reason: "namoro" });
    expect(first.changed).toBe(true);
    expect(store.isPartner("dm-user-a")).toBe(true);
    expect(store.isPartner("dm-user-b")).toBe(false);

    const blocked = store.advance("dm-user-b", "dating", { displayName: "Bia" });
    expect(blocked.changed).toBe(false);
    expect(blocked.blocked).toBe(true);
  });

  it("builds faithful prompt for non-partner when committed", () => {
    store.advance("dm-gabbis", "married", { displayName: "Gabbis" });
    const ctx = store.buildPromptContext("dm-stranger", null);
    expect(ctx.isPartner).toBe(false);
    expect(ctx.lines.join(" ")).toMatch(/fiel|comprometida|casada/i);
    // Com quem ela está não é da conta de terceiros.
    expect(ctx.lines.join(" ")).not.toMatch(/Gabbis/);
  });

  it("no grupo, parceiro recebe tom discreto e namoro não avança", () => {
    store.advance("dm-gabbis", "dating", { displayName: "Gabbis" });
    const ctx = store.buildPromptContext("dm-gabbis", null, { isGroup: true });
    expect(ctx.lines.join(" ")).toMatch(/discreto/i);
    expect(ctx.lines.join(" ")).not.toMatch(/Como anda/);
  });

  it("pedido de namoro feito no grupo não muda o status", () => {
    const turn = store.processTurn({ message: "teto namora comigo? eu te amo muito", userId: "5511999", isGroup: true });
    expect(turn.changed).toBe(false);
    expect(store.isCommitted()).toBe(false);
  });

  it("parceiro é a própria pessoa, nunca trocada pela dona", () => {
    const runtime = { defaults: { learningTargetUserId: "5516999999999" }, longTerm: { getProfile: () => ({ facts: {} }), updateProfile() {} } };
    store.advance("dm-5511888", "dating", { displayName: "Bia", runtime });
    expect(store.getState().partnerUserId).toBe("dm-5511888");
  });

  it("builds partner prompt with warmth", () => {
    store.advance("dm-gabbis", "dating", { displayName: "Gabbis" });
    const ctx = store.buildPromptContext("dm-gabbis", null);
    expect(ctx.isPartner).toBe(true);
    expect(ctx.lines.join(" ")).toMatch(/namorando com Gabbis/i);
    expect(ctx.lines.join(" ")).toMatch(/recíproco|valorize/i);
  });

  it("processes flirt from non-partner", () => {
    store.advance("dm-gabbis", "dating", { displayName: "Gabbis" });
    const turn = store.processTurn({
      message: "namora comigo teto",
      userId: "dm-other",
      isGroup: false
    });
    expect(turn.flirtFromNonPartner).toBe(true);
    expect(store.getState().partnerUserId).toBe("dm-gabbis");
  });

  it("ends relationship on breakup from partner", () => {
    store.advance("dm-gabbis", "dating", { displayName: "Gabbis" });
    const ended = store.processTurn({
      message: "acho que a gente tem que terminar",
      userId: "dm-gabbis"
    });
    expect(ended.changed).toBe(true);
    expect(ended.event).toBe("breakup");
    expect(store.getState().status).toBe("single");
  });
});
