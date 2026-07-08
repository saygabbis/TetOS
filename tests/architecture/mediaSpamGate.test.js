import { describe, expect, it } from "vitest";
import {
  isMediaPlaceholderOnly,
  isMediaSpamBurst,
  shouldRespondToMediaOnly
} from "../../src/core/media/mediaSpamGate.js";

describe("mediaSpamGate", () => {
  it("allows DM visual media without caption", () => {
    expect(
      shouldRespondToMediaOnly({
        media: { type: "sticker" },
        isDirect: true,
        userId: "u1"
      })
    ).toBe(true);
  });

  it("allows group visual media with vision transcript", () => {
    expect(
      shouldRespondToMediaOnly({
        media: { type: "image", transcript: "gato fofo" },
        isDirect: false,
        hasVisionOrTranscript: true,
        userId: "u2"
      })
    ).toBe(true);
  });

  it("blocks burst spam without address", () => {
    const media = { type: "sticker", path: "/tmp/s1.webp" };
    const opts = { media, isDirect: false, isReply: false, userId: "spam-user" };
    for (let i = 0; i < 3; i += 1) {
      expect(shouldRespondToMediaOnly(opts)).toBe(true);
    }
    expect(isMediaSpamBurst("spam-user", media)).toBe(true);
    expect(shouldRespondToMediaOnly(opts)).toBe(false);
  });

  it("detects placeholder-only media text", () => {
    expect(isMediaPlaceholderOnly("[sticker]", { type: "sticker" })).toBe(true);
    expect(isMediaPlaceholderOnly("olá", { type: "sticker" })).toBe(false);
    expect(isMediaPlaceholderOnly("[sticker]", { type: "sticker", transcript: "gato" })).toBe(
      false
    );
  });
});
