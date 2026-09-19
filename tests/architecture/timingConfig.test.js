import { describe, expect, it } from "vitest";
import {
  estimateFollowupTypingDelayMs,
  estimateTypingDelayMs,
  resolveTimingConfig
} from "../../src/core/timing/timingConfig.js";

const cfg = {
  ...resolveTimingConfig({}),
  random: () => 0.5
};

describe("estimateFollowupTypingDelayMs", () => {
  it("floors empty/short follow-ups at 500ms", () => {
    expect(estimateFollowupTypingDelayMs("", cfg)).toBe(500);
    expect(estimateFollowupTypingDelayMs("kk", cfg)).toBeGreaterThanOrEqual(500);
    expect(estimateFollowupTypingDelayMs("kk", cfg)).toBeLessThan(700);
  });

  it("scales with text length between 0.5s and the current typing max", () => {
    const short = estimateFollowupTypingDelayMs("ué", cfg);
    const medium = estimateFollowupTypingDelayMs("a".repeat(80), cfg);
    const long = estimateFollowupTypingDelayMs("a".repeat(220), cfg);
    const longer = estimateFollowupTypingDelayMs("a".repeat(400), cfg);

    expect(short).toBeGreaterThanOrEqual(500);
    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
    expect(long).toBe(cfg.typingMaxDelayMs);
    expect(longer).toBe(cfg.typingMaxDelayMs);
    expect(long).toBeLessThanOrEqual(cfg.typingMaxDelayMs);
  });

  it("never exceeds today's first-bubble typing cap", () => {
    const followup = estimateFollowupTypingDelayMs("a".repeat(80), cfg);
    const legacy = estimateTypingDelayMs("a".repeat(80), 1, { ...cfg, random: () => 0.5 });
    expect(followup).toBeLessThanOrEqual(cfg.typingMaxDelayMs);
    expect(followup).toBeLessThanOrEqual(legacy);
  });
});
