import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync
} from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const VIDEO_LIKE_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".gif", ".avi"]);

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

/**
 * Extrai 1–N PNGs para visão (vídeo, GIF, WebP animado).
 * @returns {{ frames: string[], tmpDir: string|null, disposable: string[] }}
 */
export async function extractFramesForVision(filePath, { maxFrames = 3, maxDurationSec = 8 } = {}) {
  const ext = extname(filePath).toLowerCase();
  const disposable = [];

  if (ext === ".webp") {
    const out = join(tmpdir(), `tetos-vision-${Date.now()}-frame.png`);
    await sharp(filePath, { animated: true, pages: 1, limitInputPixels: false })
      .png()
      .toFile(out);
    disposable.push(out);
    return { frames: [out], tmpDir: null, disposable };
  }

  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
    return { frames: [filePath], tmpDir: null, disposable };
  }

  if (!VIDEO_LIKE_EXT.has(ext)) {
    try {
      const out = join(tmpdir(), `tetos-vision-${Date.now()}-frame.png`);
      await runFfmpeg(ffmpeg(filePath).outputOptions(["-frames:v", "1", "-update", "1"]).save(out));
      if (existsSync(out) && statSync(out).size > 32) {
        disposable.push(out);
        return { frames: [out], tmpDir: null, disposable };
      }
      unlinkSync(out);
    } catch {
      /* tenta direto abaixo */
    }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "tetos-vision-"));
  const pattern = join(tmpDir, "f_%03d.png");
  mkdirSync(tmpDir, { recursive: true });

  try {
    await runFfmpeg(
      ffmpeg(filePath)
        .outputOptions([
          "-an",
          "-t",
          String(maxDurationSec),
          "-vf",
          "fps=1,scale=512:-1:force_original_aspect_ratio=decrease",
          "-frames:v",
          String(maxFrames)
        ])
        .output(pattern)
    );
  } catch {
    const single = join(tmpDir, "f_001.png");
    try {
      await runFfmpeg(
        ffmpeg(filePath).outputOptions(["-frames:v", "1", "-update", "1"]).save(single)
      );
    } catch {
      rmSync(tmpDir, { recursive: true, force: true });
      return { frames: [], tmpDir: null, disposable };
    }
  }

  const frames = readdirSync(tmpDir)
    .filter((f) => /^f_\d+\.png$/i.test(f))
    .sort()
    .map((f) => join(tmpDir, f))
    .filter((p) => existsSync(p) && statSync(p).size > 32);

  if (!frames.length) {
    rmSync(tmpDir, { recursive: true, force: true });
    return { frames: [], tmpDir: null, disposable };
  }

  return { frames, tmpDir, disposable };
}

function mediaKindLabel(mediaType, isAnimated) {
  if (mediaType === "sticker") return isAnimated ? "Sticker animada" : "Sticker";
  if (mediaType === "gif" || isAnimated) return "GIF/vídeo animado";
  if (mediaType === "video") return "Vídeo";
  return "Imagem";
}

/**
 * BLIP (semantic) + fallback PIL no primeiro frame ou em vários quadros de vídeo/GIF.
 */
export async function enrichMediaVision(
  runtime,
  { filePath, mediaType = "image", isAnimated = false } = {}
) {
  if (!filePath || !runtime) return null;

  const ext = extname(filePath).toLowerCase();
  const needsExtract =
    mediaType === "video" ||
    mediaType === "gif" ||
    isAnimated ||
    VIDEO_LIKE_EXT.has(ext);

  let frames = [filePath];
  let tmpDir = null;
  let disposable = [];

  if (needsExtract) {
    const extracted = await extractFramesForVision(filePath);
    frames = extracted.frames;
    tmpDir = extracted.tmpDir;
    disposable = extracted.disposable ?? [];
  }

  try {
    if (!frames.length) return null;

    const captions = [];
    for (let i = 0; i < frames.length; i++) {
      const desc =
        (await runtime.semanticVisionAnalyzer?.analyze?.({
          filePath: frames[i],
          mediaType,
          isAnimated
        })) ??
        (await runtime.visualAnalyzer?.analyze?.({
          filePath: frames[i],
          mediaType,
          isAnimated
        }));
      if (desc) {
        captions.push(frames.length > 1 ? `[quadro ${i + 1}] ${desc}` : desc);
      }
    }

    if (!captions.length) return null;
    if (captions.length === 1) return captions[0];

    const kind = mediaKindLabel(mediaType, isAnimated);
    return `${kind} (${captions.length} quadros): ${captions.join(" | ")}`;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    for (const p of disposable) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}
