import { describe, expect, it } from "vitest";
import { parseUrlDownloadArgs } from "../../src/integrations/whatsapp/urlDownloadArgsParse.js";

describe("url download args parser", () => {
  it("parses youtube url and mp3 mode", () => {
    const parsed = parseUrlDownloadArgs("youtube", ["https://youtu.be/abc123", "mp3"]);
    expect(parsed.error).toBeNull();
    expect(parsed).toMatchObject({
      command: "youtube",
      url: "https://youtu.be/abc123",
      mode: "mp3"
    });
  });

  it("defaults youtube to mp4", () => {
    const parsed = parseUrlDownloadArgs("yt", ["https://youtube.com/watch?v=abc"]);
    expect(parsed.mode).toBe("mp4");
  });

  it("parses twitter modes", () => {
    const parsed = parseUrlDownloadArgs("twitter", [
      "https://twitter.com/kasane/photo",
      "user"
    ]);
    expect(parsed.mode).toBe("user");
  });

  it("accepts generic download for any host", () => {
    const parsed = parseUrlDownloadArgs("download", ["https://vimeo.com/123456"]);
    expect(parsed.error).toBeNull();
    expect(parsed.command).toBe("download");
  });

  it("rejects platform mismatch", () => {
    const parsed = parseUrlDownloadArgs("reddit", ["https://youtube.com/watch?v=abc"]);
    expect(parsed.error).toMatch(/YouTube/i);
  });

  it("requires url", () => {
    const parsed = parseUrlDownloadArgs("instagram", ["post"]);
    expect(parsed.error).toMatch(/link/i);
  });

  it("parses thumbnail without extra mode", () => {
    const parsed = parseUrlDownloadArgs("thumb", ["https://youtu.be/xyz"]);
    expect(parsed.command).toBe("thumbnail");
    expect(parsed.mode).toBe("post");
  });

  it("defaults quality to full", () => {
    const parsed = parseUrlDownloadArgs("yt", ["https://youtu.be/abc", "mp3"]);
    expect(parsed.quality).toBe("full");
  });

  it("parses quality token and aliases", () => {
    const parsed = parseUrlDownloadArgs("youtube", [
      "https://youtu.be/abc",
      "mp4",
      "mid"
    ]);
    expect(parsed.quality).toBe("mid");

    const aliased = parseUrlDownloadArgs("yt", ["https://youtu.be/abc", "baixa"]);
    expect(aliased.quality).toBe("low");
  });

  it("rejects invalid quality", () => {
    const parsed = parseUrlDownloadArgs("youtube", [
      "https://youtu.be/abc",
      "mp4",
      "ultra"
    ]);
    expect(parsed.error).toMatch(/qualidade/i);
  });

  it("rejects quality on thumbnail", () => {
    const parsed = parseUrlDownloadArgs("thumb", [
      "https://youtu.be/xyz",
      "low"
    ]);
    expect(parsed.error).toMatch(/thumbnail/i);
  });
});
