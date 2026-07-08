import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isAnimatedImage } from "../../src/core/media/backgroundRemovalService.js";
import { MediaProcessor } from "../../src/core/media/mediaProcessor.js";

const SAMPLE_WEBP_AS_JPG =
  "data/media/3EB0C43DBA4BB5A86450B9-quoted-image.jpg";

describe("animated image detection", () => {
  it("detects animated webp even with .jpg extension", async () => {
    if (!existsSync(SAMPLE_WEBP_AS_JPG)) return;
    await expect(isAnimatedImage(SAMPLE_WEBP_AS_JPG)).resolves.toBe(true);
  });

  it(
    "converts disguised animated webp to sticker without error",
    async () => {
      if (!existsSync(SAMPLE_WEBP_AS_JPG)) return;
      const dir = mkdtempSync(join(tmpdir(), "tetos-anim-sticker-"));
      const input = join(dir, "quoted-image.jpg");
      copyFileSync(SAMPLE_WEBP_AS_JPG, input);
      const processor = new MediaProcessor({ outputDir: dir, maxStickerBytes: 500 * 1024 });
      const result = await processor.toSticker({ type: "image", path: input }, "stretch");
      expect(result?.path).toBeTruthy();
    },
    60_000
  );
});
