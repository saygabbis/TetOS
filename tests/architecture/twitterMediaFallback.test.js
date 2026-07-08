import { describe, expect, it } from "vitest";
import {
  extractTwitterStatusId,
  resolveTwitterMediaItems,
  shouldUseTwitterMediaFallback
} from "../../src/core/media/twitterMediaFallback.js";

describe("twitter media fallback", () => {
  it("extracts status id from x.com urls", () => {
    expect(
      extractTwitterStatusId(
        "https://x.com/kh0KM4Owii6325/status/2074118628430258680?s=20"
      )
    ).toBe("2074118628430258680");
  });

  it("detects yt-dlp no-video errors for fallback", () => {
    expect(
      shouldUseTwitterMediaFallback(
        new Error("[twitter] 123: No video could be found in this tweet"),
        "post"
      )
    ).toBe(true);
    expect(shouldUseTwitterMediaFallback(new Error("fail"), "mp3")).toBe(false);
  });

  it("resolves image media for image-only tweets", async () => {
    const { statusId, items } = await resolveTwitterMediaItems(
      "https://x.com/kh0KM4Owii6325/status/2074118628430258680",
      "post"
    );
    expect(statusId).toBe("2074118628430258680");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].type).toBe("image");
    expect(items[0].url).toMatch(/pbs\.twimg\.com/);
  });
});
