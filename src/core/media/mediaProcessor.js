import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import {
  applyBackgroundToPng,
  isAnimatedImage,
  isAnimatedMedia,
  removeAnimatedBackground,
  removeImageBackground
} from "./backgroundRemovalService.js";
import { probeStickerIsAnimated, isLikelyStaticRaster } from "./stickerAnimation.js";
import { STICKER_DURATION_MAX_MS } from "./stickerDurationParse.js";
import { readFileHead } from "./fileHead.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/** Sem duração no comando: 5 s (seguro no WhatsApp). Com arg (ex. 10s): até 30 s. */
const WHATSAPP_ANIMATED_STICKER_DEFAULT_MS = 5000;
const WHATSAPP_ANIMATED_STICKER_MAX_BYTES = 500 * 1024;

function animatedStickerBudget(maxStickerBytes) {
  return Math.min(maxStickerBytes, WHATSAPP_ANIMATED_STICKER_MAX_BYTES);
}

function resolveAnimatedDurationMs(maxDurationMs) {
  if (maxDurationMs == null || maxDurationMs <= 0) {
    return WHATSAPP_ANIMATED_STICKER_DEFAULT_MS;
  }
  return Math.min(maxDurationMs, STICKER_DURATION_MAX_MS);
}

function maxAnimatedFramesForDuration(durationMs) {
  const sec = resolveAnimatedDurationMs(durationMs) / 1000;
  return Math.ceil(sec * 30) + 10;
}

function buildVideoTrimPrefix(durationSec) {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return "";
  return `trim=duration=${d},setpts=PTS-STARTPTS,`;
}

async function isValidAnimatedSticker(filePath, expectedEdge = 512, durationMs = null) {
  try {
    const meta = await sharp(filePath, { animated: true }).metadata();
    const pages = Number(meta?.pages ?? 0);
    const width = Number(meta?.width ?? 0);
    const pageHeight = Number(meta?.pageHeight ?? 0);
    const height = Number(meta?.height ?? 0);
    const maxFrames = durationMs != null ? maxAnimatedFramesForDuration(durationMs) : maxAnimatedFramesForDuration(STICKER_DURATION_MAX_MS);
    if (width < 32) return false;
    if (pages === 1) {
      return width === expectedEdge && height === expectedEdge;
    }
    if (pages > maxFrames) return false;
    const frameH = pageHeight > 0 ? pageHeight : height;
    if (frameH > 0 && Math.abs(frameH - expectedEdge) > 24 && Math.abs(height - expectedEdge) > 24) {
      return width <= expectedEdge + 24;
    }
    return width <= expectedEdge + 24;
  } catch {
    return false;
  }
}

/** Animado → pipeline local; estático → pode usar API remove.bg. */
export async function isAnimatedRemoveBgTarget(input) {
  if (!input?.path) return false;
  if (input.type === "video" || input.type === "gif") return true;
  if (input.isAnimated === true) return true;
  if (input.type === "sticker") {
    return probeStickerIsAnimated(input.path, { isAnimatedHint: input.isAnimated });
  }
  if (input.type === "image" || input.type === "document") {
    return isAnimatedMedia(input.path) || (await isAnimatedImage(input.path));
  }
  return false;
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function stickerOutputSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function outPath(baseDir, inputPath, suffix, ext) {
  ensureDir(baseDir);
  const name = basename(inputPath, extname(inputPath));
  return join(baseDir, `${name}-${suffix}.${ext}`);
}

function outPathUnique(baseDir, inputPath, suffix, ext) {
  ensureDir(baseDir);
  const name = basename(inputPath, extname(inputPath));
  return join(baseDir, `${name}-${suffix}-${Date.now()}.${ext}`);
}

/** Reaproveita figurinha já gerada em derived/ (evita re-encode de 10+ min em GIF/vídeo). */
async function reuseDerivedStickerIfFresh(
  inputPath,
  mode,
  outputDir,
  maxStickerBytes,
  maxDurationMs
) {
  const derived = outPath(outputDir, inputPath, `sticker-${mode}`, "webp");
  if (!existsSync(derived) || stickerOutputSize(derived) === 0) return null;

  try {
    const srcMtime = statSync(inputPath).mtimeMs;
    const cacheMtime = statSync(derived).mtimeMs;
    if (cacheMtime < srcMtime) return null;
  } catch {
    return null;
  }

  const budget = animatedStickerBudget(maxStickerBytes);
  let finalPath = derived;
  const size = stickerOutputSize(finalPath);
  if (size === 0 || size > budget) return null;

  const durationMs = resolveAnimatedDurationMs(maxDurationMs);
  const needsAnimatedCheck =
    isGifLikeFile(inputPath) || /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(inputPath);
  if (needsAnimatedCheck && !(await isValidAnimatedSticker(finalPath, 512, durationMs))) {
    return null;
  }

  return { kind: "image", path: finalPath, fromCache: true, sizeBytes: size };
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

async function shrinkStaticStickerWebpIfNeeded(filePath, maxBytes) {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  const meta = await sharp(filePath, { animated: true }).metadata().catch(() => ({}));
  if (Number(meta?.pages ?? 1) > 1) return;
  for (let q = 82; q >= 40; q -= 14) {
    const buf = await sharp(filePath).webp({ quality: q, effort: 2 }).toBuffer();
    writeFileSync(filePath, buf);
    if (buf.length <= maxBytes) return;
  }
}

/** Calcula quantos frames incluir para respeitar maxDurationMs sem alterar FPS. */
async function computeMaxPagesForDuration(inputPath, maxDurationMs) {
  if (!maxDurationMs || maxDurationMs <= 0) return -1;
  const meta = await sharp(inputPath, { animated: true }).metadata().catch(() => ({}));
  const pages = Number(meta?.pages ?? 1);
  if (pages <= 1) return -1;

  const delays = meta.delay;
  const delayArr = Array.isArray(delays) ? delays : delays != null ? [delays] : [100];

  let elapsed = 0;
  for (let i = 0; i < pages; i++) {
    const d = Number(delayArr[i % delayArr.length]) || 100;
    elapsed += d;
    if (elapsed > maxDurationMs) return Math.max(1, i);
  }
  return pages;
}

async function buildSharpAnimatedInputOpts(inputPath, maxDurationMs) {
  const opts = { animated: true, limitInputPixels: false };
  if (maxDurationMs) {
    const maxPages = await computeMaxPagesForDuration(inputPath, maxDurationMs);
    if (maxPages > 0) opts.pages = maxPages;
  } else {
    opts.pages = -1;
  }
  return opts;
}

/** Ficheiro GIF animado em disco (WhatsApp muitas vezes manda GIF como MP4 sem alpha — aí não há transparência a recuperar). */
function isGifLikeFile(inputPath) {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".gif") return true;
  const s = readFileHead(inputPath, 6).toString("ascii");
  return s.startsWith("GIF87") || s.startsWith("GIF89");
}

/**
 * GIF animado → WebP (fallback). Poucos presets, sem nearLossless (minutos em GIF curto).
 */
const ANIMATED_SHARP_PRESETS = Object.freeze([
  { edge: 512, quality: 62, effort: 2 },
  { edge: 512, quality: 48, effort: 2 },
  { edge: 416, quality: 36, effort: 1 }
]);

async function gifAnimatedToStickerSharp(inputPath, mode, outputDir, maxStickerBytes, maxDurationMs) {
  const output = outPath(outputDir, inputPath, `sticker-${mode}`, "webp");
  const budgetBytes = animatedStickerBudget(maxStickerBytes);
  const animatedInputOpts = await buildSharpAnimatedInputOpts(
    inputPath,
    resolveAnimatedDurationMs(maxDurationMs)
  );

  const resizeFor = (edge) => {
    if (mode === "stretch") {
      return { width: edge, height: edge, fit: "fill" };
    }
    if (mode === "contain") {
      return {
        width: edge,
        height: edge,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      };
    }
    return { width: edge, height: edge, fit: "cover", position: "centre" };
  };

  const basePipeline = () => {
    let p = sharp(inputPath, animatedInputOpts).ensureAlpha();
    if (mode === "contain") {
      p = p.trim({ threshold: 18, lineArt: false });
    }
    return p;
  };

  for (const { edge, quality, effort } of ANIMATED_SHARP_PRESETS) {
    try {
      await basePipeline()
        .resize(resizeFor(edge))
        .webp({
          lossless: false,
          quality,
          alphaQuality: 90,
          effort
        })
        .toFile(output);
      const sz = statSync(output).size;
      if (sz > 0 && sz <= budgetBytes) {
        return { kind: "image", path: output };
      }
    } catch {
      /* próximo */
    }
  }

  if (stickerOutputSize(output) > 0) {
    return { kind: "image", path: output };
  }
  return null;
}

async function animatedGifToSticker(inputPath, mode, outputDir, maxStickerBytes, maxDurationMs) {
  try {
    const ffmpegResult = await videoToSticker(
      inputPath,
      mode,
      outputDir,
      maxStickerBytes,
      maxDurationMs
    );
    if (ffmpegResult?.path && stickerOutputSize(ffmpegResult.path) > 0) {
      return ffmpegResult;
    }
  } catch {
    /* Sharp abaixo */
  }
  return gifAnimatedToStickerSharp(
    inputPath,
    mode,
    outputDir,
    maxStickerBytes,
    maxDurationMs
  );
}

async function imageToSticker(inputPath, mode, outputDir, maxStickerBytes) {
  const output = outPath(outputDir, inputPath, `sticker-${mode}`, "webp");
  let img = sharp(inputPath).ensureAlpha();
  if (mode === "contain") {
    img = img.trim({ threshold: 18, lineArt: false });
  }
  const webpOpts = { quality: 82, effort: 2, lossless: false };
  if (mode === "stretch") {
    await img.resize(512, 512, { fit: "fill" }).webp(webpOpts).toFile(output);
  } else if (mode === "contain") {
    await img
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp(webpOpts)
      .toFile(output);
  } else {
    await img.resize(512, 512, { fit: "cover", position: "centre" }).webp(webpOpts).toFile(output);
  }
  await shrinkStaticStickerWebpIfNeeded(output, maxStickerBytes);
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(output).size;
  } catch {}
  return { kind: "image", path: output, sizeBytes };
}

function buildVideoStickerVf(mode, fps, edge, durationSec) {
  const trim = buildVideoTrimPrefix(durationSec);
  const f = `${trim}fps=${fps}`;
  if (mode === "stretch") {
    return `${f},scale=${edge}:${edge}:flags=lanczos,format=yuv420p`;
  }
  if (mode === "contain") {
    /* RGBA antes do pad: senão YUV trata padding como preto opaco em muitos builds. */
    return `${f},format=rgba,scale=${edge}:${edge}:force_original_aspect_ratio=decrease,pad=${edge}:${edge}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  }
  return `${f},scale=${edge}:${edge}:force_original_aspect_ratio=increase,crop=${edge}:${edge},format=yuv420p`;
}

async function runVideoStickerEncode(inputPath, output, { mode, edge, fps, quality, durationSec }) {
  const vf = buildVideoStickerVf(mode, fps, edge, durationSec);
  await runFfmpeg(
    ffmpeg(inputPath)
      .inputOptions(["-t", String(durationSec)])
      .outputOptions([
        "-an",
        "-vf",
        vf,
        "-c:v",
        "libwebp",
        "-lossless",
        "0",
        "-quality",
        String(quality),
        "-compression_level",
        "3",
        "-preset",
        "picture",
        "-loop",
        "0"
      ])
      .save(output)
  );
}

/**
 * Vídeo/GIF → figurinha animada: ffmpeg libwebp direto, para no primeiro encode no budget.
 */
async function videoToSticker(inputPath, mode, outputDir, maxStickerBytes, maxDurationMs) {
  const output = outPath(outputDir, inputPath, `sticker-${mode}`, "webp");
  const budgetBytes = animatedStickerBudget(maxStickerBytes);
  const durationMs = resolveAnimatedDurationMs(maxDurationMs);
  const durationSec = durationMs / 1000;

  const ffmpegPresets = [
    { edge: 512, fps: 16, quality: 70 },
    { edge: 512, fps: 12, quality: 52 },
    { edge: 432, fps: 10, quality: 38 }
  ];

  let bestPath = null;
  let bestSize = Number.POSITIVE_INFINITY;

  for (const preset of ffmpegPresets) {
    try {
      await runVideoStickerEncode(inputPath, output, {
        mode,
        durationSec,
        ...preset
      });
    } catch {
      continue;
    }
    const size = stickerOutputSize(output);
    if (size === 0) continue;
    if (size <= budgetBytes) {
      return { kind: "image", path: output };
    }
    if (size < bestSize) {
      bestSize = size;
      bestPath = output;
    }
  }

  if (bestPath && bestSize <= budgetBytes * 1.25) {
    return { kind: "image", path: bestPath };
  }

  if (bestPath) {
    return { kind: "image", path: bestPath };
  }

  throw new Error("falha ao gerar figurinha animada");
}

/**
 * Recomprime figurinha WebP existente até caber em maxStickerBytes.
 * Animadas: só reduz qualidade/resolução — sem filtro fps (preserva FPS).
 */
async function optimizeStickerWebp(inputPath, outputDir, maxStickerBytes) {
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(inputPath).size;
  } catch {
    throw new Error("figurinha nao encontrada");
  }

  if (sizeBytes <= maxStickerBytes) {
    return { kind: "image", path: inputPath, alreadyOptimized: true, sizeBytes };
  }

  const output = outPath(outputDir, inputPath, "optimized", "webp");
  const meta = await sharp(inputPath, { animated: true }).metadata().catch(() => ({}));
  const pages = Number(meta?.pages ?? 1);
  const isAnimated = pages > 1;

  if (!isAnimated) {
    writeFileSync(output, readFileSync(inputPath));
    await shrinkStaticStickerWebpIfNeeded(output, maxStickerBytes);
    try {
      sizeBytes = statSync(output).size;
    } catch {
      sizeBytes = 0;
    }
    return { kind: "image", path: output, alreadyOptimized: false, sizeBytes };
  }

  const sharpQualities = [72, 58, 44, 32];
  for (const quality of sharpQualities) {
    try {
      await sharp(inputPath, { animated: true, limitInputPixels: false })
        .webp({ lossless: false, quality, effort: 3, alphaQuality: 100 })
        .toFile(output);
      sizeBytes = stickerOutputSize(output);
      if (sizeBytes > 0 && sizeBytes <= maxStickerBytes) {
        return { kind: "image", path: output, alreadyOptimized: false, sizeBytes };
      }
    } catch {
      /* próximo */
    }
  }

  for (const edge of [464, 416]) {
    try {
      await sharp(inputPath, { animated: true, limitInputPixels: false })
        .resize(edge, edge, { fit: "inside" })
        .webp({ lossless: false, quality: 32, effort: 2, alphaQuality: 90 })
        .toFile(output);
      sizeBytes = stickerOutputSize(output);
      if (sizeBytes > 0 && sizeBytes <= maxStickerBytes) {
        return { kind: "image", path: output, alreadyOptimized: false, sizeBytes };
      }
    } catch {
      /* próximo */
    }
  }

  return { kind: "image", path: output, alreadyOptimized: false, sizeBytes };
}

/**
 * Um passo de compressão para o comando .optimize — sem teto de KiB.
 * Cada chamada tenta o preset mais leve que ainda reduz o arquivo; repetir comprime de novo.
 */
async function optimizeStickerStep(inputPath, outputDir) {
  const inputSize = stickerOutputSize(inputPath);
  if (inputSize === 0) throw new Error("figurinha nao encontrada");

  const meta = await sharp(inputPath, { animated: true }).metadata().catch(() => ({}));
  const pages = Number(meta?.pages ?? 1);
  const isAnimated = pages > 1;
  const output = outPathUnique(outputDir, inputPath, "optimized", "webp");
  const minGain = 0.97;

  if (!isAnimated) {
    for (let q = 86; q >= 24; q -= 6) {
      const buf = await sharp(inputPath).webp({ quality: q, effort: 4 }).toBuffer();
      if (buf.length > 0 && buf.length < inputSize * minGain) {
        writeFileSync(output, buf);
        return {
          kind: "image",
          path: output,
          alreadyOptimized: false,
          sizeBytes: buf.length,
          previousSizeBytes: inputSize
        };
      }
    }
    return { kind: "image", path: inputPath, alreadyOptimized: true, sizeBytes: inputSize };
  }

  const steps = [
    { quality: 78 },
    { quality: 68 },
    { quality: 58 },
    { quality: 48 },
    { quality: 38 },
    { quality: 28 },
    { quality: 22 }
  ];

  for (const { quality } of steps) {
    try {
      await sharp(inputPath, { animated: true, limitInputPixels: false })
        .webp({ lossless: false, quality, effort: 4 })
        .toFile(output);
      const size = stickerOutputSize(output);
      if (size > 0 && size < inputSize * minGain) {
        return {
          kind: "image",
          path: output,
          alreadyOptimized: false,
          sizeBytes: size,
          previousSizeBytes: inputSize
        };
      }
    } catch {
      /* próximo */
    }
  }

  const fpsSteps = [
    { quality: 40, fps: 12 },
    { quality: 34, fps: 10 },
    { quality: 28, fps: 8 },
    { quality: 22, fps: 8 }
  ];

  for (const { quality, fps } of fpsSteps) {
    const opts = [
      "-an",
      "-c:v",
      "libwebp",
      "-lossless",
      "0",
      "-quality",
      String(quality),
      "-loop",
      "0"
    ];
    if (fps) opts.push("-vf", `fps=${fps},format=yuv420p`);
    await runFfmpeg(ffmpeg(inputPath).outputOptions(opts).save(output));
    const size = stickerOutputSize(output);
    if (size > 0 && size < inputSize * minGain && (await isValidAnimatedSticker(output, 512))) {
      return {
        kind: "image",
        path: output,
        alreadyOptimized: false,
        sizeBytes: size,
        previousSizeBytes: inputSize
      };
    }
  }

  for (const edge of [464, 416, 368, 320]) {
    await runFfmpeg(
      ffmpeg(inputPath)
        .outputOptions([
          "-an",
          "-vf",
          `scale=${edge}:${edge},format=yuv420p`,
          "-c:v",
          "libwebp",
          "-lossless",
          "0",
          "-quality",
          "30",
          "-loop",
          "0"
        ])
        .save(output)
    );
    const size = stickerOutputSize(output);
    if (size > 0 && size < inputSize * minGain && (await isValidAnimatedSticker(output, edge))) {
      return {
        kind: "image",
        path: output,
        alreadyOptimized: false,
        sizeBytes: size,
        previousSizeBytes: inputSize
      };
    }
  }

  return { kind: "image", path: inputPath, alreadyOptimized: true, sizeBytes: inputSize };
}

async function staticStickerToImage(inputPath, outputDir) {
  const output = outPath(outputDir, inputPath, "toimg", "png");
  try {
    const meta = await sharp(inputPath, { animated: true }).metadata().catch(() => ({}));
    const pages = Number(meta?.pages ?? 1);
    const pipeline = sharp(
      inputPath,
      pages > 1 ? { animated: true, pages: 1, limitInputPixels: false } : { limitInputPixels: false }
    );
    await pipeline.ensureAlpha().png().toFile(output);
    if (existsSync(output) && statSync(output).size > 32) {
      return { kind: "image", path: output };
    }
  } catch {
    /* fallback ffmpeg abaixo */
  }

  try {
    await runFfmpeg(
      ffmpeg(inputPath)
        .outputOptions(["-frames:v", "1", "-update", "1"])
        .save(output)
    );
    if (existsSync(output) && statSync(output).size > 32) {
      return { kind: "image", path: output };
    }
  } catch {
    /* tenta sharp sem animated */
  }

  await sharp(inputPath, { limitInputPixels: false }).ensureAlpha().png().toFile(output);
  return { kind: "image", path: output };
}

const REMOVEBG_GIF_VF =
  "fps=12,scale=512:512:force_original_aspect_ratio=decrease,split[s0][s1];[s0]palettegen=reserve_transparent=1:stats_mode=single[p];[s1][p]paletteuse=alpha";

/** GIF com alpha para .removebg — evita MP4 sem transparência do .toimg. */
async function animatedStickerToGifForRemoveBg(inputPath, outputDir) {
  const outputGif = outPath(outputDir, inputPath, "removebg-src", "gif");
  try {
    await sharp(inputPath, {
      animated: true,
      pages: -1,
      limitInputPixels: false
    })
      .resize(512, 512, {
        fit: "inside",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .gif({ effort: 8, colours: 256 })
      .toFile(outputGif);
  } catch {
    /* sharp falhou — ffmpeg abaixo */
  }

  if (!looksLikeGifFile(outputGif)) {
    await runFfmpeg(
      ffmpeg(inputPath)
        .inputOptions(["-ignore_loop", "0"])
        .outputOptions(["-an", "-t", "5", "-vf", REMOVEBG_GIF_VF, "-loop", "0"])
        .save(outputGif)
    );
  }

  if (!looksLikeGifFile(outputGif)) {
    throw new Error("nao foi possivel converter figurinha animada para GIF");
  }
  return { kind: "gif", path: outputGif, toimgGifPath: outputGif };
}

/** MP4 sem `ftyp` ou ridículo de pequeno costuma virar bolha cinza no WhatsApp. */
const MIN_TOIMG_MP4_BYTES = 320;

function looksLikeGifFile(filePath) {
  try {
    const st = statSync(filePath);
    if (st.size < 64) return false;
    const head = readFileSync(filePath, { start: 0, end: 5 });
    const sig = head.toString("ascii");
    return sig.startsWith("GIF87a") || sig.startsWith("GIF89a");
  } catch {
    return false;
  }
}

function looksLikeMp4File(filePath) {
  try {
    const st = statSync(filePath);
    if (st.size < MIN_TOIMG_MP4_BYTES) return false;
    const head = readFileSync(filePath, { start: 0, end: 11 });
    return (
      head.length >= 12 &&
      head[4] === 0x66 &&
      head[5] === 0x74 &&
      head[6] === 0x79 &&
      head[7] === 0x70
    );
  } catch {
    return false;
  }
}

/** MP4 pode ter `ftyp` mas estar truncado ou sem `moov` — WhatsApp mostra bolha cinza; o GIF em documento ainda funciona. */
function mp4PassesFfmpegDecode(filePath) {
  try {
    const exe = ffmpegInstaller.path;
    const r = spawnSync(
      exe,
      ["-nostdin", "-hide_banner", "-xerror", "-v", "error", "-i", filePath, "-an", "-t", "16", "-f", "null", "-"],
      { encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 }
    );
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Duração aproximada para metadados do vídeo no WhatsApp (opcional mas ajuda alguns clientes). */
function probeMp4DurationSecondsRounded(filePath) {
  try {
    const exe = ffmpegInstaller.path;
    const r = spawnSync(exe, ["-nostdin", "-hide_banner", "-i", filePath], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024
    });
    const m = /Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/.exec(String(r.stderr || ""));
    if (!m) return undefined;
    const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return Math.min(60, Math.max(1, Math.ceil(total)));
  } catch {
    return undefined;
  }
}

function mp4OkForToimgPlayback(filePath) {
  if (!looksLikeMp4File(filePath)) return { ok: false };
  if (!mp4PassesFfmpegDecode(filePath)) return { ok: false };
  return { ok: true, seconds: probeMp4DurationSecondsRounded(filePath) };
}

/**
 * Vários builds do WhatsApp no telemóvel não tratam bem `videoMessage` só com vídeo (sem track de áudio):
 * deixa de reproduzir na bolha e pode nem mostrar download. Mux AAC silencioso + copy do H.264.
 */
function muxSilentAacIntoMp4Sync(srcPath, dstPath) {
  const exe = ffmpegInstaller.path;
  const r = spawnSync(
    exe,
    [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      srcPath,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-shortest",
      "-movflags",
      "+faststart",
      dstPath
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
  );
  return r.status === 0;
}

function sealToimgMp4ForMobile(mp4Path) {
  const tmp = mp4Path.replace(/\.mp4$/i, ".wa-aud.mp4");
  if (!muxSilentAacIntoMp4Sync(mp4Path, tmp)) {
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
  if (!mp4OkForToimgPlayback(tmp).ok) {
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
  try {
    unlinkSync(mp4Path);
  } catch {}
  try {
    renameSync(tmp, mp4Path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
}

function finalizeToimgPlaybackMp4(mp4Path, fallbackProbe) {
  sealToimgMp4ForMobile(mp4Path);
  const p = mp4OkForToimgPlayback(mp4Path);
  return p.ok ? p : fallbackProbe;
}

/** libx264 + yuv420p exige dimensões pares — evita vídeo “em branco” no cliente. */
const SHARP_GIF_TO_MP4_VF =
  "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos";

/**
 * GIF grande como `video` + gifPlayback falha no WhatsApp (só chega o documento).
 * Reencode agressivo até existir MP4 reproduzível para a bolha; o GIF completo mantém-se em `toimgGifPath`.
 */
async function encodeAggressivePlaybackMp4FromGif(gifPath, outputMp4) {
  const attempts = [
    ["-vf", SHARP_GIF_TO_MP4_VF, "-crf", "26", "-preset", "fast"],
    ["-vf", "fps=12,scale=480:-2:flags=lanczos", "-crf", "28", "-preset", "fast"],
    ["-vf", "fps=10,scale=400:-2:flags=lanczos", "-crf", "30", "-preset", "veryfast"],
    ["-vf", "fps=10,scale=360:-2:flags=lanczos", "-crf", "32", "-preset", "veryfast"],
    ["-vf", "fps=8,scale=320:-2:flags=lanczos", "-crf", "34", "-preset", "veryfast"],
    ["-vf", "fps=6,scale=288:-2:flags=lanczos", "-crf", "36", "-preset", "veryfast"]
  ];
  for (const extra of attempts) {
    try {
      await runFfmpeg(
        ffmpeg(gifPath)
          .inputOptions(["-ignore_loop", "0"])
          .videoCodec("libx264")
          .outputOptions([
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            "-shortest",
            "-t",
            "8",
            ...extra,
            "-profile:v",
            "baseline",
            "-level",
            "3.1"
          ])
          .save(outputMp4)
      );
      const probe = mp4OkForToimgPlayback(outputMp4);
      if (probe.ok) {
        return { ok: true, seconds: probe.seconds };
      }
    } catch {
      /* próxima tentativa */
    }
  }
  return { ok: false };
}

async function ffmpegAnimatedWebpFallbackToMp4(inputPath, outputMp4) {
  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions([
        "-an",
        "-shortest",
        "-t",
        "8",
        "-vf",
        "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:black",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-profile:v",
        "baseline",
        "-level",
        "3.1"
      ])
      .save(outputMp4)
  );
}

/**
 * Figurinha animada → .toimg:
 * 1) Sharp gera GIF (mantém alpha / transparência para o documento).
 * 2) Tenta MP4 (H.264) para autoplay no chat.
 * 3) Se falhar, reencode agressivo do GIF → MP4 reproduzível (evita GIF enorme na bolha).
 * 4) Bolha MP4 com gifPlayback + GIF completo como documento; fallback: GIF inline + documento.
 * `toimgGifPath` guarda o GIF completo para fallback de envio inline.
 */
async function animatedStickerToVideo(inputPath, outputDir) {
  ensureDir(outputDir);
  const outputGif = outPath(outputDir, inputPath, "toimg", "gif");
  const outputMp4 = outPath(outputDir, inputPath, "toimg", "mp4");

  await sharp(inputPath, {
    animated: true,
    pages: -1,
    limitInputPixels: false
  })
    .resize(512, 512, {
      fit: "inside",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .gif({ effort: 8, colours: 256 })
    .toFile(outputGif);
if (!looksLikeGifFile(outputGif)) {
    throw new Error("nao foi possivel gerar gif a partir da figurinha animada");
  }

  const withGifDoc = (path, mime, extras = {}) => ({
    kind: "video",
    path,
    toimgGifPath: outputGif,
    toimgPlaybackMime: mime,
    ...extras
  });

  try {
    await runFfmpeg(
      ffmpeg(outputGif)
        .inputOptions(["-ignore_loop", "0"])
        .videoCodec("libx264")
        .outputOptions([
          "-pix_fmt yuv420p",
          "-movflags +faststart",
          "-an",
          "-shortest",
          "-t 8",
          "-vf",
          SHARP_GIF_TO_MP4_VF,
          "-profile:v baseline",
          "-level 3.1"
        ])
        .save(outputMp4)
    );
    const mp4Probe = mp4OkForToimgPlayback(outputMp4);
    if (mp4Probe.ok) {
      const fin = finalizeToimgPlaybackMp4(outputMp4, mp4Probe);
return withGifDoc(outputMp4, "video/mp4", {
        toimgPlaybackSeconds: fin.seconds
      });
    }
  } catch {
    /* fallback abaixo */
  }

  try {
    await ffmpegAnimatedWebpFallbackToMp4(inputPath, outputMp4);
    const mp4Probe = mp4OkForToimgPlayback(outputMp4);
    if (mp4Probe.ok) {
      const fin = finalizeToimgPlaybackMp4(outputMp4, mp4Probe);
      return withGifDoc(outputMp4, "video/mp4", {
        toimgPlaybackSeconds: fin.seconds
      });
    }
  } catch {
    /* usa GIF no chat */
  }

  const playbackEnc = await encodeAggressivePlaybackMp4FromGif(outputGif, outputMp4);
  if (playbackEnc.ok) {
    const fb = {
      ok: true,
      seconds: playbackEnc.seconds
    };
    const fin = finalizeToimgPlaybackMp4(outputMp4, fb);
return withGifDoc(outputMp4, "video/mp4", {
      toimgPlaybackSeconds: fin.seconds
    });
  }
return {
    kind: "video",
    path: null,
    toimgGifPath: outputGif,
    toimgPlaybackSkipped: true
  };
}

export class MediaProcessor {
  constructor({
    outputDir = "./data/media/derived",
    maxStickerBytes = 950 * 1024,
    removeBgApiKeys = null,
    removeBgApiKey = "",
    removeBgModel = "small"
  } = {}) {
    this.outputDir = outputDir;
    this.maxStickerBytes = maxStickerBytes;
    if (Array.isArray(removeBgApiKeys) && removeBgApiKeys.length > 0) {
      this.removeBgApiKeys = removeBgApiKeys.filter(Boolean);
    } else {
      const single = String(removeBgApiKey ?? "").trim();
      this.removeBgApiKeys = single ? [single] : [];
    }
    this.removeBgModel = ["small", "medium", "large"].includes(removeBgModel) ? removeBgModel : "small";
  }

  async toSticker(input, mode = "stretch", { maxDurationMs } = {}) {
    if (!input?.path || !input?.type) throw new Error("invalid media input");
    if (!existsSync(input.path)) throw new Error("arquivo de midia nao encontrado");
    const animatedDurationMs = resolveAnimatedDurationMs(maxDurationMs);

    const cached = await reuseDerivedStickerIfFresh(
      input.path,
      mode,
      this.outputDir,
      this.maxStickerBytes,
      animatedDurationMs
    );
    if (cached?.path) return cached;

    const looksStatic = isLikelyStaticRaster(input.path);
    const animatedSource = looksStatic
      ? false
      : await probeStickerIsAnimated(input.path, {
          isAnimatedHint: input.isAnimated
        });

    let result;
    if (input.type === "image" || input.type === "sticker" || input.type === "document") {
      if (animatedSource) {
        result = await animatedGifToSticker(
          input.path,
          mode,
          this.outputDir,
          this.maxStickerBytes,
          animatedDurationMs
        );
      } else {
        result = await imageToSticker(input.path, mode, this.outputDir, this.maxStickerBytes);
      }
    } else if (input.type === "video" || input.type === "gif") {
      if (isGifLikeFile(input.path)) {
        result = await animatedGifToSticker(
          input.path,
          mode,
          this.outputDir,
          this.maxStickerBytes,
          animatedDurationMs
        );
      } else {
        result = await videoToSticker(
          input.path,
          mode,
          this.outputDir,
          this.maxStickerBytes,
          animatedDurationMs
        );
      }
    } else {
      throw new Error(`unsupported media type for sticker: ${input.type}`);
    }

    if (!result?.path || stickerOutputSize(result.path) === 0) {
      throw new Error("falha ao gerar figurinha");
    }
    return this.autoOptimizeIfNeeded(result);
  }

  async autoOptimizeIfNeeded(result) {
    if (!result?.path) return result;
    const size = stickerOutputSize(result.path);
    if (size === 0) return result;

    const meta = await sharp(result.path, { animated: true }).metadata().catch(() => ({}));
    const isAnimated = Number(meta?.pages ?? 1) > 1;
    const budget = isAnimated ? animatedStickerBudget(this.maxStickerBytes) : this.maxStickerBytes;
    if (size <= budget) return result;

    const optimized = await optimizeStickerWebp(result.path, this.outputDir, budget);
    if (optimized?.path && !optimized.alreadyOptimized) {
      return { ...result, path: optimized.path };
    }
    return result;
  }

  async optimizeSticker(input) {
    if (!input?.path) throw new Error("invalid sticker input");
    return optimizeStickerStep(input.path, this.outputDir);
  }

  async toMediaFromSticker(input, { forRemoveBg = false } = {}) {
    if (!input?.path) throw new Error("invalid sticker input");
    const animated = await probeStickerIsAnimated(input.path, {
      isAnimatedHint: input.isAnimated
    });
    if (animated) {
      if (forRemoveBg) {
        return animatedStickerToGifForRemoveBg(input.path, this.outputDir);
      }
      return animatedStickerToVideo(input.path, this.outputDir);
    }
    return staticStickerToImage(input.path, this.outputDir);
  }

  /**
   * Remove fundo de imagem, GIF, vídeo ou figurinha (converte com .toimg antes).
   * @param {{ background?: string|null, model?: string }} options
   */
  async removeBackground(input, { background = null, model } = {}) {
    if (!input?.path) throw new Error("invalid media input");

    let workPath = input.path;
    let animated = false;

    if (input.type === "sticker") {
      const converted = await this.toMediaFromSticker(input, { forRemoveBg: true });
      if (!converted?.path) {
        throw new Error("nao foi possivel preparar figurinha para removebg");
      }
      const gifSource = converted.toimgGifPath || converted.path;
      animated =
        converted.kind === "gif" ||
        converted.kind === "video" ||
        isGifLikeFile(gifSource) ||
        isAnimatedMedia(gifSource);
      workPath = gifSource;
    } else if (input.type === "video" || input.type === "gif") {
      animated = true;
    } else if (input.type === "image" || input.type === "document") {
      animated =
        isAnimatedMedia(input.path) || (await isAnimatedImage(input.path));
    } else {
      throw new Error(`tipo de midia nao suportado para removebg: ${input.type}`);
    }

    ensureDir(this.outputDir);
    const effectiveModel =
      model && ["small", "medium", "large"].includes(model) ? model : this.removeBgModel;

    const bgOpts = {
      background,
      removeBgApiKeys: this.removeBgApiKeys.length ? this.removeBgApiKeys : undefined,
      model: effectiveModel
    };

    if (animated) {
      return removeAnimatedBackground(workPath, this.outputDir, {
        background,
        model: effectiveModel
      });
    }

    const base = basename(workPath, extname(workPath));
    const transparentPath = join(this.outputDir, `${base}-nobg.png`);
    const finalPath = join(
      this.outputDir,
      `${base}-removebg${background ? "-color" : ""}.png`
    );

    await removeImageBackground(workPath, transparentPath, bgOpts);
    await applyBackgroundToPng(transparentPath, finalPath, background);

    return {
      kind: "image",
      path: finalPath,
      mimetype: "image/png",
      fileName: background ? "sem-fundo-colorido.png" : "sem-fundo.png",
      documentOnly: true,
      removeBgModel: effectiveModel
    };
  }
}
