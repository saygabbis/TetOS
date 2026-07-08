import { describe, expect, it } from "vitest";
import { findPreferredDownloadFile } from "../../src/core/media/ytDlpRunner.js";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

describe("yt-dlp runner file pick", () => {
  it("prefers mp4 over webp when mode is post", () => {
    const dir = mkdtempSync(join(tmpdir(), "tetos-ytdlp-"));
    const now = Date.now() / 1000;
    const webp = join(dir, "dl-id.webp");
    const mp4 = join(dir, "dl-id.mp4");
    writeFileSync(webp, "x");
    writeFileSync(mp4, "x".repeat(1000));
    utimesSync(webp, now, now + 1);
    utimesSync(mp4, now, now);
    const picked = findPreferredDownloadFile(dir, { sinceMs: 0, mode: "post" });
    expect(picked).toBe(mp4);
  });

  it("ignores empty files when picking downloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "tetos-ytdlp-empty-"));
    const now = Date.now() / 1000;
    const empty = join(dir, "dl-stale.mp4");
    const mp4 = join(dir, "dl-id.mp4");
    writeFileSync(empty, "");
    writeFileSync(mp4, "x".repeat(1000));
    utimesSync(empty, now, now + 2);
    utimesSync(mp4, now, now);
    const picked = findPreferredDownloadFile(dir, { sinceMs: 0, mode: "mp4" });
    expect(picked).toBe(mp4);
  });

  it("does not pick mp4 when mode is mp3", () => {
    const dir = mkdtempSync(join(tmpdir(), "tetos-ytdlp-mp3-"));
    const now = Date.now() / 1000;
    const mp3 = join(dir, "dl-id.mp3");
    const mp4 = join(dir, "dl-id.mp4");
    writeFileSync(mp3, "x".repeat(500));
    writeFileSync(mp4, "x".repeat(5000));
    utimesSync(mp3, now, now);
    utimesSync(mp4, now, now + 5);
    const picked = findPreferredDownloadFile(dir, { sinceMs: 0, mode: "mp3" });
    expect(picked).toBe(mp3);
  });
});
