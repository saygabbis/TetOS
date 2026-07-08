import { describe, expect, it } from "vitest";
import {
  isSupportedConvertFormat,
  normalizeConvertFormat,
  SUPPORTED_CONVERT_FORMATS
} from "../../src/core/media/mediaConverter.js";

describe("media converter", () => {
  it("normalizes convert formats", () => {
    expect(normalizeConvertFormat(".MP4")).toBe("mp4");
    expect(normalizeConvertFormat("jpeg")).toBe("jpg");
    expect(normalizeConvertFormat("")).toBeNull();
  });

  it("validates supported formats", () => {
    expect(isSupportedConvertFormat("png")).toBe(true);
    expect(isSupportedConvertFormat("mp3")).toBe(true);
    expect(isSupportedConvertFormat("pdf")).toBe(false);
  });

  it("lists expected formats", () => {
    expect(SUPPORTED_CONVERT_FORMATS).toContain("webp");
    expect(SUPPORTED_CONVERT_FORMATS).toContain("m4a");
  });
});
