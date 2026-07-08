import { describe, expect, it } from "vitest";
import {
  audioQualityValue,
  applyTwitterImageQuality,
  normalizeDownloadQuality,
  videoFormatSelector
} from "../../src/core/media/downloadQuality.js";

describe("download quality helpers", () => {
  it("normalizes aliases", () => {
    expect(normalizeDownloadQuality("alta")).toBe("full");
    expect(normalizeDownloadQuality("medio")).toBe("mid");
    expect(normalizeDownloadQuality("baixa")).toBe("low");
    expect(normalizeDownloadQuality("")).toBe("full");
    expect(normalizeDownloadQuality("xyz", { defaultQuality: null })).toBeNull();
  });

  it("selects yt-dlp format strings by tier", () => {
    expect(videoFormatSelector("full")).toContain("bestvideo");
    expect(videoFormatSelector("mid")).toContain("height<=720");
    expect(videoFormatSelector("low")).toContain("worstvideo");
  });

  it("maps audio quality tiers", () => {
    expect(audioQualityValue("full")).toBe("0");
    expect(audioQualityValue("mid")).toBe("5");
    expect(audioQualityValue("low")).toBe("9");
  });

  it("rewrites twitter image urls", () => {
    const url = "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=orig";
    expect(applyTwitterImageQuality(url, "low")).toContain("name=small");
    expect(applyTwitterImageQuality(url, "mid")).toContain("name=large");
    expect(applyTwitterImageQuality(url, "full")).toContain("name=orig");
  });
});
