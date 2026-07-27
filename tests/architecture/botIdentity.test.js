import { describe, expect, it } from "vitest";
import {
  botIdentityIds,
  buildBotActorIds,
  isBotIdentity,
  resolveCanonicalHumanUserId,
  sanitizeIdentityAliases
} from "../../src/core/channels/botIdentity.js";

const runtime = {
  defaults: {
    learningTargetUserId: "5516988137617",
    botWaPhone: "6283879987068",
    ownerWaJids: ["157947506229421@lid"],
    botWaJids: ["174165839581324@lid"]
  },
  whatsappBotPhoneE164: "6283879987068"
};

describe("bot identity separation", () => {
  it("knows bot vs owner ids", () => {
    expect(isBotIdentity(runtime, "6283879987068")).toBe(true);
    expect(isBotIdentity(runtime, "dm-6283879987068")).toBe(true);
    expect(isBotIdentity(runtime, "5516988137617")).toBe(false);
    expect(isBotIdentity(runtime, "dm-5516988137617")).toBe(false);
  });

  it("bot actor ids include connected jid lid", () => {
    const ids = buildBotActorIds(runtime, "6283879987068", "174165839581324@lid");
    expect(ids.has("174165839581324")).toBe(true);
    expect(ids.has("6283879987068")).toBe(true);
    expect(ids.has("5516988137617")).toBe(false);
    expect(ids.has("teto")).toBe(true);
  });

  it("sanitizes gabbis alias from bot profile", () => {
    const cleaned = sanitizeIdentityAliases(
      ["6283879987068", "gabbis", "5516988137617"],
      runtime,
      "6283879987068"
    );
    expect(cleaned).toContain("6283879987068");
    expect(cleaned).not.toContain("gabbis");
    expect(cleaned).not.toContain("5516988137617");
  });

  it("resolves owner canonical id", () => {
    expect(resolveCanonicalHumanUserId(runtime, "dm-157947506229421", { preferOwner: true })).toBe(
      "dm-5516988137617"
    );
    expect(resolveCanonicalHumanUserId(runtime, "6283879987068")).toBeNull();
  });

  it("collects bot identity ids", () => {
    const ids = botIdentityIds(runtime);
    expect(ids.has("6283879987068")).toBe(true);
    expect(ids.has("174165839581324")).toBe(true);
  });
});
