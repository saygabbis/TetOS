import { describe, expect, it, vi } from "vitest";
import { formatMediaInputText } from "../../src/core/channels/mediaTimelineEnrich.js";
import { applyExtendedChecks } from "../../src/core/timing/timingChecks.js";
import {
  abortPendingHoldStores,
  computeDirectBatchMs,
  firstBubbleTypingFloorMs,
  shouldFlushPendingOnIncoming,
  shouldSkipThinkDelaySleep,
  shouldSplitBurst,
  stampMediaHoldStart,
  thinkDelaySleepMs
} from "../../src/integrations/whatsapp/directBatchPlanner.js";

describe("directBatchPlanner", () => {
  it("holds visual/audio media ~5s and does not reset remaining on merge", () => {
    const now = 1_000_000;
    const media = { type: "image", path: "/tmp/a.jpg" };
    expect(
      computeDirectBatchMs({ media, mediaHoldStartedAt: now }, null, {
        mediaHoldMs: 5000,
        now
      })
    ).toBe(5000);

    expect(
      computeDirectBatchMs(
        { media, message: "kkkk", mediaHoldStartedAt: now },
        { media, mediaHoldStartedAt: now },
        { mediaHoldMs: 5000, now: now + 2000 }
      )
    ).toBe(3000);
  });

  it("uses a short quiet window for DM text without media", () => {
    const ms = computeDirectBatchMs({ message: "oi" }, null, {
      stillTyping: false,
      batchWindowMs: 1200
    });
    expect(ms).toBeGreaterThanOrEqual(400);
    expect(ms).toBeLessThanOrEqual(700);
  });

  it("only flushes pending on a different quote, not any reply", () => {
    const previous = { isReply: true, quotedMessageId: "a" };
    expect(shouldFlushPendingOnIncoming(previous, { isReply: true, quotedMessageId: "a" })).toBe(
      false
    );
    expect(shouldFlushPendingOnIncoming(previous, { isReply: true, quotedMessageId: "b" })).toBe(
      true
    );
    expect(shouldFlushPendingOnIncoming(previous, { isReply: true })).toBe(false);
  });

  it("splits on a new media path and isolated question", () => {
    expect(
      shouldSplitBurst(
        { media: { type: "image", path: "/a" }, message: "olha" },
        { media: { type: "image", path: "/b" }, message: "e essa" }
      )
    ).toBe(true);

    expect(
      shouldSplitBurst(
        { message: "estava falando daquele assunto longo do almoco de ontem a tarde" },
        { message: "voce vai hoje?" }
      )
    ).toBe(true);

    expect(
      shouldSplitBurst(
        { media: { type: "image", path: "/a" }, message: "[image]" },
        { message: "kkkk" }
      )
    ).toBe(false);
  });

  it("stamps hold start from the first media in the merge", () => {
    const started = 50;
    expect(
      stampMediaHoldStart(
        { media: { type: "sticker" }, mediaHoldStartedAt: started },
        { message: "haha" },
        90
      )
    ).toBe(started);
  });

  it("skips thinkDelay in DM but keeps groggy/wake delays", () => {
    expect(shouldSkipThinkDelaySleep({ isGroup: false })).toBe(true);
    expect(thinkDelaySleepMs({ isGroup: false, timingPlan: { thinkDelayMs: 2000 } })).toBe(0);
    expect(
      shouldSkipThinkDelaySleep({ isGroup: false, sleepGroggy: true })
    ).toBe(false);
    expect(
      thinkDelaySleepMs({
        isGroup: true,
        timingPlan: { thinkDelayMs: 2500 }
      })
    ).toBe(2500);
    expect(
      thinkDelaySleepMs({
        isGroup: true,
        isDirectMention: true,
        timingPlan: { thinkDelayMs: 2500 }
      })
    ).toBe(0);
  });

  it("lowers first-bubble typing floor for a single DM bubble", () => {
    expect(
      firstBubbleTypingFloorMs({ firstBubbleTypingFloorMs: 480 }, { batchedCount: 1, isGroup: false })
    ).toBe(180);
    expect(
      firstBubbleTypingFloorMs({ firstBubbleTypingFloorMs: 480 }, { batchedCount: 3, isGroup: false })
    ).toBe(480);
  });

  it("aborts pending media hold without leaving the timer armed", () => {
    vi.useFakeTimers();
    const pendingBySession = new Map();
    const deferredBySession = new Map();
    const pendingByGroupChannel = new Map();
    const timer = setTimeout(() => {}, 5000);
    pendingBySession.set("sid", { timer, media: { type: "image" } });
    deferredBySession.set("sid", { message: "depois" });
    expect(
      abortPendingHoldStores(
        { pendingBySession, deferredBySession, pendingByGroupChannel },
        { sessionId: "sid", remoteJid: "x@s.whatsapp.net" }
      )
    ).toBe(true);
    expect(pendingBySession.has("sid")).toBe(false);
    expect(deferredBySession.has("sid")).toBe(false);
    vi.useRealTimers();
  });
});

describe("formatMediaInputText", () => {
  it("joins caption and visual transcript for chat", () => {
    expect(
      formatMediaInputText({
        text: "kkkk",
        media: { type: "image", transcript: "gato de chapéu" }
      })
    ).toBe("kkkk gato de chapéu");
  });
});

describe("timingChecks media hint", () => {
  it("does not add +1200 read delay when the turn has no media", () => {
    const plan = { readDelayMs: 400, thinkDelayMs: 1200, typingProfile: "normal" };
    const reasons = [];
    applyExtendedChecks(
      plan,
      { mediaTimingHint: { readDelayBoost: 1200, note: "media_timing_hint" } },
      reasons
    );
    expect(plan.readDelayMs).toBe(400);
    expect(reasons).not.toContain("media_timing_hint");
  });

  it("adds the hint only when ctx.media is present", () => {
    const plan = { readDelayMs: 400, thinkDelayMs: 1200, typingProfile: "normal" };
    const reasons = [];
    applyExtendedChecks(
      plan,
      {
        media: { type: "image" },
        mediaTimingHint: { readDelayBoost: 1200, note: "media_timing_hint" }
      },
      reasons
    );
    expect(plan.readDelayMs).toBe(1600);
    expect(reasons).toContain("media_timing_hint");
  });
});
