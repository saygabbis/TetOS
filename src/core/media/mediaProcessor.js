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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function outPath(baseDir, inputPath, suffix, ext) {
  ensureDir(baseDir);
  const name = basename(inputPath, extname(inputPath));
  return join(baseDir, `${name}-${suffix}.${ext}`);
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

/** Formato WhatsApp para figurinha estática no app móvel: WebP (PNG costuma renderizar no Web e falhar no celular). */
const STATIC_STICKER_WEBP = { lossless: true };

async function shrinkStaticStickerWebpIfNeeded(filePath, maxBytes) {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  for (let q = 88; q >= 34; q -= 7) {
    const buf = await sharp(filePath).webp({ quality: q, effort: 4 }).toBuffer();
    writeFileSync(filePath, buf);
    if (buf.length <= maxBytes) return;
  }
}

/** Ficheiro GIF animado em disco (WhatsApp muitas vezes manda GIF como MP4 sem alpha — aí não há transparência a recuperar). */
function isGifLikeFile(inputPath) {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".gif") return true;
  try {
    const head = readFileSync(inputPath, { start: 0, end: 5 });
    const s = head.toString("ascii");
    return s.startsWith("GIF87a") || s.startsWith("GIF89a");
  } catch {
    return false;
  }
}

/**
 * GIF animado → WebP animado **só com libvips/Sharp** (sem ffmpeg no meio: evita YUV sem alpha e bordas pretas no .fsticker).
 */
async function gifAnimatedToStickerSharp(inputPath, mode, outputDir, maxStickerBytes) {
  const output = outPath(outputDir, inputPath, `sticker-${mode}`, "webp");
  const edges = [512, 464, 416, 368];
  const qualities = [86, 78, 68, 58, 48, 38, 30];

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

  /** Base: canal alpha garantido; em “contain” tira barras pretas uniformes que muitos GIF usam em vez de transparência real. */
  const basePipeline = () => {
    let p = sharp(inputPath, { animated: true, pages: -1, limitInputPixels: false }).ensureAlpha();
    if (mode === "contain") {
      p = p.trim({ threshold: 18, lineArt: false });
    }
    return p;
  };

  if (mode === "contain") {
    try {
      await basePipeline()
        .resize(resizeFor(512))
        .webp({ lossless: true, effort: 6 })
        .toFile(output);
      const sz = statSync(output).size;
      if (sz > 0 && sz <= maxStickerBytes) {
        const meta = await sharp(output).metadata().catch(() => ({}));
        // #region agent log
        fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "99966e" },
          body: JSON.stringify({
            sessionId: "99966e",
            location: "mediaProcessor.js:gifAnimatedToStickerSharp",
            message: "gif→webp sharp lossless ok",
            data: {
              mode,
              sizeBytes: sz,
              hasAlpha: meta.hasAlpha,
              pages: meta.pages
            },
            timestamp: Date.now(),
            hypothesisId: "H-fsticker-gif-sharp",
            runId: "gif-alpha-v1"
          })
        }).catch(() => {});
        // #endregion
        return { kind: "image", path: output };
      }
    } catch {
      /* lossy */
    }
  }

  for (const edge of edges) {
    for (const quality of qualities) {
      try {
        await basePipeline()
          .resize(resizeFor(edge))
          .webp({
            lossless: false,
            quality,
            alphaQuality: 100,
            nearLossless: true,
            effort: 4
          })
          .toFile(output);
        const sz = statSync(output).size;
        if (sz > 0 && sz <= maxStickerBytes) {
          const meta = await sharp(output).metadata().catch(() => ({}));
          // #region agent log
          fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "99966e" },
            body: JSON.stringify({
              sessionId: "99966e",
              location: "mediaProcessor.js:gifAnimatedToStickerSharp",
              message: "gif→webp sharp lossy ok",
              data: {
                mode,
                edge,
                quality,
                sizeBytes: sz,
                hasAlpha: meta.hasAlpha,
                pages: meta.pages
              },
              timestamp: Date.now(),
              hypothesisId: "H-fsticker-gif-sharp",
              runId: "gif-alpha-v1"
            })
          }).catch(() => {});
          // #endregion
          return { kind: "image", path: output };
        }
      } catch {
        /* próximo */
      }
    }
  }

  return { kind: "image", path: output };
}

async function imageToSticker(inputPath, mode, outputDir, maxStickerBytes) {
  const output = outPath(outputDir, inputPath, `sticker-${mode}`, "webp");
  let img = sharp(inputPath, { animated: true }).ensureAlpha();
  if (mode === "contain") {
    img = img.trim({ threshold: 18, lineArt: false });
  }
  if (mode === "stretch") {
    await img.resize(512, 512, { fit: "fill" }).webp(STATIC_STICKER_WEBP).toFile(output);
  } else if (mode === "contain") {
    await img
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp(STATIC_STICKER_WEBP)
      .toFile(output);
  } else {
    await img.resize(512, 512, { fit: "cover", position: "centre" }).webp(STATIC_STICKER_WEBP).toFile(output);
  }
  await shrinkStaticStickerWebpIfNeeded(output, maxStickerBytes);
  const meta = await sharp(output).metadata();
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(output).size;
  } catch {}
  // #region agent log
  fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "99966e" },
    body: JSON.stringify({
      sessionId: "99966e",
      location: "mediaProcessor.js:imageToSticker",
      message: "output after sharp webp (mobile-compatible sticker)",
      data: {
        format: meta.format,
        width: meta.width,
        height: meta.height,
        pages: meta.pages,
        hasAlpha: meta.hasAlpha,
        sizeBytes,
        mode,
        filename: basename(output)
      },
      timestamp: Date.now(),
      hypothesisId: "H1",
      runId: "webp-fix-v1"
    })
  }).catch(() => {});
  // #endregion
  return { kind: "image", path: output };
}

function buildVideoStickerVf(mode, fps, edge) {
  const f = `fps=${fps}`;
  if (mode === "stretch") {
    return `${f},scale=${edge}:${edge}:flags=lanczos`;
  }
  if (mode === "contain") {
    /* RGBA antes do pad: senão YUV trata padding como preto opaco em muitos builds. */
    return `${f},format=rgba,scale=${edge}:${edge}:force_original_aspect_ratio=decrease,pad=${edge}:${edge}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  }
  return `${f},scale=${edge}:${edge}:force_original_aspect_ratio=increase,crop=${edge}:${edge}`;
}

/**
 * Vídeo/GIF → figurinha animada: WebP animado (não MP4 no campo sticker).
 * Reduz qualidade → fps → resolução até caber em maxStickerBytes (WhatsApp ~1 MiB).
 */
async function videoToSticker(inputPath, mode, outputDir, maxStickerBytes) {
  const output = outPath(outputDir, inputPath, `sticker-${mode}`, "webp");
  const qualities = [82, 72, 62, 52, 44, 36, 28];
  const fpss = [15, 12, 10, 8];
  const edges = [512, 464, 416, 368];

  let lastSize = 0;

  for (const edge of edges) {
    for (const fps of fpss) {
      const vf = buildVideoStickerVf(mode, fps, edge);
      for (const quality of qualities) {
        await runFfmpeg(
          ffmpeg(inputPath)
            .outputOptions([
              "-an",
              "-shortest",
              "-t",
              "8",
              "-vf",
              vf,
              "-c:v",
              "libwebp",
              "-lossless",
              "0",
              "-quality",
              String(quality),
              "-preset",
              "default",
              "-loop",
              "0"
            ])
            .save(output)
        );
        try {
          lastSize = statSync(output).size;
        } catch {
          lastSize = 0;
        }
        if (lastSize <= maxStickerBytes) {
          // #region agent log
          fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "99966e" },
            body: JSON.stringify({
              sessionId: "99966e",
              location: "mediaProcessor.js:videoToSticker",
              message: "animated webp sticker within budget",
              data: {
                sizeBytes: lastSize,
                maxStickerBytes,
                filename: basename(output),
                mode,
                edge,
                fps,
                quality
              },
              timestamp: Date.now(),
              hypothesisId: "H4",
              runId: "sticker-budget-v1"
            })
          }).catch(() => {});
          // #endregion
          return { kind: "image", path: output };
        }
      }
    }
  }
  // #region agent log
  fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "99966e" },
    body: JSON.stringify({
      sessionId: "99966e",
      location: "mediaProcessor.js:videoToSticker",
      message: "animated webp sticker still over budget (best effort)",
      data: {
        sizeBytes: lastSize,
        maxStickerBytes,
        filename: basename(output),
        mode
      },
      timestamp: Date.now(),
      hypothesisId: "H4",
      runId: "sticker-budget-v1"
    })
  }).catch(() => {});
  // #endregion
  return { kind: "image", path: output };
}

async function staticStickerToImage(inputPath, outputDir) {
  const output = outPath(outputDir, inputPath, "toimg", "png");
  await sharp(inputPath).png().toFile(output);
  return { kind: "image", path: output };
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
 * 4) Bolha **só MP4** (WhatsApp não lida bem com GIF grande em `videoMessage`). Último recurso: só documento GIF.
 * `toimgGifPath` é sempre o GIF completo para o documento.
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
  constructor({ outputDir = "./data/media/derived", maxStickerBytes = 950 * 1024 } = {}) {
    this.outputDir = outputDir;
    this.maxStickerBytes = maxStickerBytes;
  }

  async toSticker(input, mode = "stretch") {
    if (!input?.path || !input?.type) throw new Error("invalid media input");
    if (input.type === "image" || input.type === "sticker" || input.type === "document") {
      if (input.type !== "sticker" && isGifLikeFile(input.path)) {
        const meta = await sharp(input.path, { animated: true }).metadata().catch(() => ({}));
        if (Number(meta?.pages ?? 1) > 1) {
          return gifAnimatedToStickerSharp(input.path, mode, this.outputDir, this.maxStickerBytes);
        }
      }
      return imageToSticker(input.path, mode, this.outputDir, this.maxStickerBytes);
    }
    if (input.type === "video" || input.type === "gif") {
      if (isGifLikeFile(input.path)) {
        return gifAnimatedToStickerSharp(input.path, mode, this.outputDir, this.maxStickerBytes);
      }
      return videoToSticker(input.path, mode, this.outputDir, this.maxStickerBytes);
    }
    throw new Error(`unsupported media type for sticker: ${input.type}`);
  }

  async toMediaFromSticker(input) {
    if (!input?.path) throw new Error("invalid sticker input");
    const meta = await sharp(input.path, { animated: true }).metadata().catch(() => ({}));
    const pages = Number(meta?.pages ?? 1);
    if (pages > 1 || input?.isAnimated) {
      return animatedStickerToVideo(input.path, this.outputDir);
    }
    return staticStickerToImage(input.path, this.outputDir);
  }
}
