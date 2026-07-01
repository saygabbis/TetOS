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

/**
 * Extrai frames no estilo Sellye (2 screenshots em 33% e 66%, fallback em t=0).
 * @returns {{ frames: string[], disposable: string[] }}
 */
export async function extractFramesSellyeStyle(mediaPath) {
  const disposable = [];
  const tmpDir = tmpdir();
  let generatedFiles = [];

  const captureScreenshots = (options) =>
    new Promise((resolve, reject) => {
      ffmpeg(mediaPath)
        .on("filenames", (filenames) => {
          generatedFiles = filenames.map((f) => join(tmpDir, f));
        })
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .screenshots(options);
    });

  try {
    await captureScreenshots({
      count: 2,
      timestamps: ["33%", "66%"],
      folder: tmpDir,
      filename: `frame_${Date.now()}_%i.png`,
      size: "512x?"
    });
  } catch {
    generatedFiles = [];
  }

  if (!generatedFiles.length) {
    try {
      await captureScreenshots({
        timestamps: [0],
        folder: tmpDir,
        filename: `frame_fallback_${Date.now()}.png`,
        size: "512x?"
      });
    } catch {
      generatedFiles = [];
    }
  }

  if (!generatedFiles.length) {
    const extracted = await extractFramesForVision(mediaPath, { maxFrames: 2 });
    const frames = extracted.frames ?? [];
    disposable.push(...(extracted.disposable ?? []));
    if (extracted.tmpDir) {
      disposable.push(extracted.tmpDir);
    }
    return { frames, disposable };
  }

  const frames = generatedFiles.filter((p) => existsSync(p) && statSync(p).size > 32);
  disposable.push(...frames);
  return { frames, disposable };
}

function mediaKindLabel(mediaType, isAnimated) {
  if (mediaType === "sticker") return isAnimated ? "Sticker animada" : "Sticker";
  if (mediaType === "gif" || isAnimated) return "GIF/vídeo animado";
  if (mediaType === "video") return "Vídeo";
  return "Imagem";
}

/**
 * Enriquece mídia com descrição visual.
 * Padrão: Ollama multimodal (Sellye). Fallback legado: BLIP + PIL local.
 */
export async function enrichMediaVision(
  runtime,
  { filePath, mediaType = "image", isAnimated = false } = {}
) {
  if (!filePath || !runtime) {
    console.log(
      "[repertorio:vision] enrich_skip",
      JSON.stringify({ reason: !filePath ? "no_filePath" : "no_runtime" })
    );
    return null;
  }

  const adapter = runtime.defaults?.visionAdapter ?? "ollama";
  const ollamaVision = runtime.ollamaVisionAnalyzer;
  const ollamaEnabled = Boolean(ollamaVision?.isEnabled?.());
  console.log(
    "[repertorio:vision] enrich_start",
    JSON.stringify({
      filePath,
      mediaType,
      isAnimated,
      adapter,
      ollamaEnabled,
      visionModel: runtime.defaults?.visionModel || runtime.defaults?.model || null
    })
  );

  if (adapter === "ollama" && ollamaEnabled) {
    const result = await ollamaVision.analyze({ filePath, mediaType, isAnimated });
    console.log(
      "[repertorio:vision] enrich_ollama_done",
      JSON.stringify({
        filePath,
        mediaType,
        ok: Boolean(result),
        preview: result ? String(result).slice(0, 120) : null
      })
    );
    runtime?.logger?.log?.("repertoire.vision", {
      step: "enrich_ollama_done",
      filePath,
      mediaType,
      ok: Boolean(result)
    });
    return result;
  }

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
