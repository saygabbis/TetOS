import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { encodeGifToMp4, looksLikeGifFile, mp4OkForPlayback, prepareMp4ForWaPlayback } from "./gifToMp4Encoder.js";

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

export async function convertMedia(inputPath, targetFormat, outputDir, options = {}) {
  const sourceMediaType = options.sourceMediaType ?? null;
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
    let fromAnimatedGif = false;
    let playbackSeconds;
    const isGif = looksLikeGifFile(inputPath);
    // #region agent log
    fetch("http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "20737f" },
      body: JSON.stringify({
        sessionId: "20737f",
        hypothesisId: "H1-H3",
        location: "mediaConverter.js:image-to-video",
        message: "branch decision",
        data: {
          inputPath,
          srcKind,
          dstKind,
          inputExt: extname(inputPath),
          inputSize: statSync(inputPath).size,
          isGif,
          branch: isGif ? "encodeGifToMp4" : "sharpSingleFrame"
        },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    if (isGif) {
      const playback = await encodeGifToMp4(inputPath, outputPath);
      fromAnimatedGif = true;
      playbackSeconds = playback.seconds;
    } else {
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
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-movflags",
            "+faststart"
          ])
          .toFormat("mp4")
          .save(outputPath)
      );
      try {
        unlinkSync(tmpPng);
      } catch {
        /* ignore */
      }
    }

    if (!existsSync(outputPath) || statSync(outputPath).size < 1) {
      throw new Error("conversao nao gerou arquivo valido");
    }

    const outSize = statSync(outputPath).size;
    const result = {
      path: outputPath,
      kind: dstKind,
      mimetype: MIME_BY_EXT[outExt] ?? "application/octet-stream",
      fileName: `${base}-convertido.${outExt}`,
      ...(fromAnimatedGif
        ? { gifPlayback: true, seconds: playbackSeconds }
        : {})
    };
    // #region agent log
    fetch("http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "20737f" },
      body: JSON.stringify({
        sessionId: "20737f",
        hypothesisId: "H3-H4",
        location: "mediaConverter.js:image-to-video-result",
        message: "image to video conversion done",
        data: { outSize, fromAnimatedGif, playbackSeconds, gifPlayback: result.gifPlayback ?? false },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    return result;
  } else if ((srcKind === "video" || srcKind === "image") && (dstKind === "video" || dstKind === "image")) {
    if (format === "gif" && srcKind === "video") {
      await runFfmpeg(
        ffmpeg(inputPath)
          .outputOptions(["-vf", "fps=10,scale=480:-1:flags=lanczos", "-loop", "0"])
          .save(outputPath)
      );
    } else if (format === "mp4" || format === "webm") {
      if (format === "mp4") {
        const inputProbe = mp4OkForPlayback(inputPath);
        if (inputProbe.ok) {
          const playback = prepareMp4ForWaPlayback(inputPath, outputPath);
          const useGifPlayback = sourceMediaType === "gif";
          // #region agent log
          fetch("http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "20737f" },
            body: JSON.stringify({
              sessionId: "20737f",
              runId: "post-fix",
              hypothesisId: "H2-fix",
              location: "mediaConverter.js:mp4-passthrough",
              message: "valid mp4 passthrough",
              data: {
                inputSize: statSync(inputPath).size,
                outSize: statSync(outputPath).size,
                sourceMediaType,
                gifPlayback: useGifPlayback,
                seconds: playback.seconds,
                inputProbeOk: inputProbe.ok
              },
              timestamp: Date.now()
            })
          }).catch(() => {});
          // #endregion
          return {
            path: outputPath,
            kind: dstKind,
            mimetype: MIME_BY_EXT[outExt] ?? "application/octet-stream",
            fileName: `${base}-convertido.${outExt}`,
            ...(useGifPlayback ? { gifPlayback: true, seconds: playback.seconds } : {})
          };
        }
        if (looksLikeGifFile(inputPath)) {
          const playback = await encodeGifToMp4(inputPath, outputPath);
          return {
            path: outputPath,
            kind: dstKind,
            mimetype: MIME_BY_EXT[outExt] ?? "application/octet-stream",
            fileName: `${base}-convertido.${outExt}`,
            gifPlayback: true,
            seconds: playback.seconds
          };
        }
      }
      // #region agent log
      fetch("http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "20737f" },
        body: JSON.stringify({
          sessionId: "20737f",
          hypothesisId: "H2",
          location: "mediaConverter.js:video-reencode",
          message: "video/image generic reencode branch",
          data: {
            inputPath,
            srcKind,
            format,
            inputExt: extname(inputPath),
            inputSize: existsSync(inputPath) ? statSync(inputPath).size : 0,
            looksLikeGif: looksLikeGifFile(inputPath)
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      await runFfmpeg(
        ffmpeg(inputPath)
          .outputOptions([
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-movflags",
            "+faststart",
            "-an",
            "-profile:v",
            "baseline",
            "-level",
            "3.1"
          ])
          .toFormat(format)
          .save(outputPath)
      );
      if (format === "mp4") {
        try {
          prepareMp4ForWaPlayback(outputPath, outputPath);
        } catch {
          /* mantém saída do reencode */
        }
      }
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

  const finalProbe = format === "mp4" ? mp4OkForPlayback(outputPath) : { ok: false };
  return {
    path: outputPath,
    kind: dstKind,
    mimetype: MIME_BY_EXT[outExt] ?? "application/octet-stream",
    fileName: `${base}-convertido.${outExt}`,
    ...(format === "mp4" && sourceMediaType === "gif" && finalProbe.ok
      ? { gifPlayback: true, seconds: finalProbe.seconds }
      : {})
  };
}
