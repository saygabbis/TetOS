import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { runYtDlpMock } = vi.hoisted(() => ({
  runYtDlpMock: vi.fn()
}));

vi.mock("../../src/core/media/ytDlpRunner.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runYtDlp: runYtDlpMock,
    fetchUrlToFile: vi.fn(async (url, dest) => dest),
    safeUnlink: vi.fn()
  };
});

import { UrlDownloadService, inferDownloadMode } from "../../src/core/media/urlDownloadService.js";
import { runYtDlp } from "../../src/core/media/ytDlpRunner.js";

describe("url download service", () => {
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), "tetos-dl-"));
  });

  function seedFile(name, size = 2048) {
    const path = join(tmpDir, name);
    writeFileSync(path, Buffer.alloc(size, 1));
    return path;
  }

  it("infers mp4 for twitter video urls", () => {
    expect(
      inferDownloadMode("https://x.com/user/status/123/video/1", "post")
    ).toBe("mp4");
  });

  it("routes youtube to yt-dlp with audio flags for mp3", async () => {
    const mp3 = seedFile("fake-dl.mp3");
    runYtDlpMock.mockResolvedValue({ path: mp3, stderr: "" });
    const svc = new UrlDownloadService({ outputDir: tmpDir });
    const out = await svc.downloadYouTube("https://youtu.be/abc", "mp3");
    expect(runYtDlp).toHaveBeenCalled();
    const args = runYtDlp.mock.calls[0][0];
    expect(args).toContain("-x");
    expect(args).toContain("mp3");
    expect(args).toContain("--no-write-thumbnail");
    expect(out.kind).toBe("audio");
    expect(out.fileName).toMatch(/\.mp3$/);
  });

  it("applies mid quality to youtube mp3", async () => {
    const mp3 = seedFile("fake-dl.mp3");
    runYtDlpMock.mockResolvedValue({ path: mp3, stderr: "" });
    const svc = new UrlDownloadService({ outputDir: tmpDir });
    await svc.downloadYouTube("https://youtu.be/abc", "mp3", "mid");
    const args = runYtDlp.mock.calls[0][0];
    const qIdx = args.indexOf("--audio-quality");
    expect(qIdx).toBeGreaterThan(-1);
    expect(args[qIdx + 1]).toBe("5");
  });

  it("applies low quality video format for mp4", async () => {
    const mp4 = seedFile("fake-dl.mp4");
    runYtDlpMock.mockResolvedValue({ path: mp4, stderr: "" });
    const svc = new UrlDownloadService({ outputDir: tmpDir });
    await svc.downloadYouTube("https://youtu.be/abc", "mp4", "low");
    const args = runYtDlp.mock.calls[0][0];
    const fIdx = args.indexOf("-f");
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toContain("worstvideo");
  });

  it("routes twitter video with mp4 merge flags", async () => {
    const mp4 = seedFile("fake-dl.mp4");
    runYtDlpMock.mockResolvedValue({ path: mp4, stderr: "" });
    const svc = new UrlDownloadService({ outputDir: tmpDir });
    const out = await svc.downloadTwitter("https://x.com/u/status/1/video/1", "post");
    const args = runYtDlp.mock.calls[0][0];
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("mp4");
    expect(runYtDlp.mock.calls[0][1].mode).toBe("mp4");
    expect(out.kind).toBe("video");
    expect(out.fileName).toMatch(/\.mp4$/);
  });

  it("falls back to vx api when yt-dlp has no twitter video", async () => {
    runYtDlpMock.mockRejectedValue(
      new Error("[twitter] 2074118628430258680: No video could be found in this tweet")
    );
    const jpg = seedFile("dl-2074118628430258680.jpg");
    const fetchMock = vi.fn(async (_url, dest) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(dest, Buffer.alloc(2048, 1));
      return dest;
    });
    vi.mocked((await import("../../src/core/media/ytDlpRunner.js")).fetchUrlToFile).mockImplementation(
      fetchMock
    );

    const svc = new UrlDownloadService({ outputDir: tmpDir });
    const out = await svc.downloadTwitter(
      "https://x.com/kh0KM4Owii6325/status/2074118628430258680",
      "post"
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(out.kind).toBe("image");
    expect(out.path).toBeTruthy();
  });
});
