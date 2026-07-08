import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const SUPPORTED_CONVERT_FORMATS = Object.freeze([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "mp4",
  "webm",
  "mp3",
  "wav",
  "ogg",
  "m4a"
]);

const IMAGE_FORMATS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff"]);
const VIDEO_FORMATS = new Set(["mp4", "webm", "mkv", "mov", "avi", "m4v"]);
const AUDIO_FORMATS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4"
};

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

function inputKind(inputPath) {
  const ext = extname(inputPath).toLowerCase().slice(1);
  if (IMAGE_FORMATS.has(ext)) return "image";
  if (VIDEO_FORMATS.has(ext)) return "video";
  if (AUDIO_FORMATS.has(ext)) return "audio";
  if (ext === "gif") return "image";
  return "unknown";
}

function outputKind(format) {
  const f = format.toLowerCase();
  if (IMAGE_FORMATS.has(f)) return "image";
  if (VIDEO_FORMATS.has(f)) return "video";
  if (AUDIO_FORMATS.has(f)) return "audio";
  return "document";
}

export function normalizeConvertFormat(raw) {
  const f = String(raw ?? "").trim().toLowerCase().replace(/^\./, "");
  if (!f) return null;
  if (f === "jpeg") return "jpg";
  return f;
}

export function isSupportedConvertFormat(format) {
  const f = normalizeConvertFormat(format);
  return Boolean(f && SUPPORTED_CONVERT_FORMATS.includes(f));
}

export async function convertMedia(inputPath, targetFormat, outputDir) {
  if (!inputPath || !existsSync(inputPath)) {
    throw new Error("arquivo de entrada invalido");
  }
  const format = normalizeConvertFormat(targetFormat);
  if (!format || !isSupportedConvertFormat(format)) {
    throw new Error(
      `Formato invalido. Suportados: ${SUPPORTED_CONVERT_FORMATS.join(", ")}`
    );
  }
  mkdirSync(outputDir, { recursive: true });
  const base = basename(inputPath, extname(inputPath));
  const outExt = format === "jpg" ? "jpg" : format;
  const outputPath = join(outputDir, `${base}-convertido.${outExt}`);
  const srcKind = inputKind(inputPath);
  const dstKind = outputKind(format);

  if (srcKind === "image" && dstKind === "image") {
    let pipeline = sharp(inputPath, { animated: format === "gif" });
    if (format === "jpg") pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
    else if (format === "png") pipeline = pipeline.png();
    else if (format === "webp") pipeline = pipeline.webp({ quality: 90 });
    else if (format === "gif") pipeline = pipeline.gif();
    await pipeline.toFile(outputPath);
  } else if (srcKind === "image" && dstKind === "video") {
    const tmpPng = join(outputDir, `${base}-frame.png`);
    await sharp(inputPath).png().toFile(tmpPng);
    await runFfmpeg(
      ffmpeg(tmpPng)
        .inputOptions(["-loop", "1"])
        .outputOptions([
          "-c:v",
          "libx264",
          "-t",
          "3",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart"
        ])
        .toFormat("mp4")
        .save(outputPath)
    );
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tmpPng);
    } catch {
      /* ignore */
    }
  } else if ((srcKind === "video" || srcKind === "image") && (dstKind === "video" || dstKind === "image")) {
    if (format === "gif" && srcKind === "video") {
      await runFfmpeg(
        ffmpeg(inputPath)
          .outputOptions(["-vf", "fps=10,scale=480:-1:flags=lanczos", "-loop", "0"])
          .save(outputPath)
      );
    } else if (format === "mp4" || format === "webm") {
      await runFfmpeg(
        ffmpeg(inputPath)
          .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
          .toFormat(format)
          .save(outputPath)
      );
    } else if (dstKind === "image") {
      await runFfmpeg(
        ffmpeg(inputPath).outputOptions(["-frames:v", "1"]).save(outputPath)
      );
    } else {
      throw new Error(`Conversao de ${srcKind} para ${format} nao suportada`);
    }
  } else if (srcKind === "video" && dstKind === "audio") {
    await runFfmpeg(
      ffmpeg(inputPath)
        .noVideo()
        .audioCodec(format === "mp3" ? "libmp3lame" : format === "wav" ? "pcm_s16le" : "copy")
        .toFormat(format)
        .save(outputPath)
    );
  } else if (srcKind === "audio" && dstKind === "audio") {
    await runFfmpeg(ffmpeg(inputPath).toFormat(format).save(outputPath));
  } else if (srcKind === "video" && format === "mp3") {
    await runFfmpeg(
      ffmpeg(inputPath).noVideo().audioCodec("libmp3lame").toFormat("mp3").save(outputPath)
    );
  } else {
    throw new Error(`Nao sei converter esse tipo de arquivo para .${format}`);
  }

  if (!existsSync(outputPath) || statSync(outputPath).size < 1) {
    throw new Error("conversao nao gerou arquivo valido");
  }

  return {
    path: outputPath,
    kind: dstKind,
    mimetype: MIME_BY_EXT[outExt] ?? "application/octet-stream",
    fileName: `${base}-convertido.${outExt}`
  };
}
