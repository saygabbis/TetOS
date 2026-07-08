import { describe, expect, it } from "vitest";
import {
  assertPlatformMatchesCommand,
  detectPlatform,
  extractYouTubeVideoId
} from "../../src/core/media/urlPlatformDetect.js";

describe("url platform detect", () => {
  it("detects major platforms", () => {
    expect(detectPlatform("https://youtu.be/abc")).toBe("youtube");
    expect(detectPlatform("https://x.com/user/status/1")).toBe("twitter");
    expect(detectPlatform("https://instagram.com/reel/abc")).toBe("instagram");
    expect(detectPlatform("https://reddit.com/r/test/comments/abc")).toBe("reddit");
    expect(detectPlatform("https://tiktok.com/@u/video/1")).toBe("tiktok");
    expect(detectPlatform("https://facebook.com/watch/?v=1")).toBe("facebook");
    expect(detectPlatform("https://vimeo.com/123")).toBe("generic");
    expect(detectPlatform("https://twitch.tv/clip/abc")).toBe("generic");
  });

  it("extracts youtube video id", () => {
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("asserts command matches platform", () => {
    expect(assertPlatformMatchesCommand("https://youtu.be/x", "reddit")).toMatch(/YouTube/i);
    expect(assertPlatformMatchesCommand("https://youtu.be/x", "youtube")).toBeNull();
    expect(assertPlatformMatchesCommand("https://vimeo.com/1", "download")).toBeNull();
  });
});
