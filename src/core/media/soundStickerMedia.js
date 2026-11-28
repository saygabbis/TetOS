/**
 * ffmpeg da figurinha com som: áudio Opus, figurinha estática → animada, toimg com som (MP4).
 * Tudo assíncrono (spawn): o bot continua respondendo enquanto o ffmpeg trabalha.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";
import { STICKER_DURATION_MAX_MS } from "./stickerDurationParse.js";

/** Duração padrão (sem tempo no comando). Com tempo (ex.: 14s) vai até o máximo das figurinhas. */
export const SOUND_STICKER_MAX_SECONDS = 10;
/** Teto absoluto, igual ao das figurinhas sem som. */
export const SOUND_STICKER_HARD_MAX_SECONDS = STICKER_DURATION_MAX_MS / 1000;
const AUDIO_MAX_BYTES = 250 * 1024;
const FFMPEG_TIMEOUT_MS = 180_000;

/** Roda o ffmpeg sem travar o processo. `input` (Buffer) vai pelo stdin. */
export function runFfmpegAsync(args, { input = null, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const base = ["-y", "-hide_banner", ...(input ? [] : ["-nostdin"])];
    let child;
    try {
      child = spawn(ffmpegInstaller.path, [...base, ...args], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, stderr: String(error?.message ?? error) });
      return;
    }
    let stderr = "";
    child.stderr.on("data", (d) => {
      if (stderr.length < 2_000_000) stderr += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: stderr + String(e?.message ?? e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr });
    });
    child.stdin.on("error", () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function outFile(dir, input, suffix, ext) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${basename(input, extname(input))}-${suffix}-${Date.now()}.${ext}`);
}

/** Duração (s) e se tem trilha de áudio, lendo o stderr do ffmpeg -i. */
export async function probeMedia(path) {
  const r = await runFfmpegAsync(["-i", path], { timeoutMs: 20_000 });
  const m = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  return { seconds, hasAudio: /Stream #.*Audio:/.test(r.stderr) };
}

/**
 * Extrai/converte áudio pra Ogg/Opus mono 48 kHz, até `maxSeconds`. Retorna { path, seconds } ou
 * null se não tem áudio.
 */
export async function extractStickerAudio(inputPath, outputDir, { maxSeconds = SOUND_STICKER_MAX_SECONDS, startSeconds = 0 } = {}) {
  const info = await probeMedia(inputPath);
  if (!info.hasAudio) return null;
  const cap = Math.max(0.5, Math.min(SOUND_STICKER_HARD_MAX_SECONDS, Number(maxSeconds) || SOUND_STICKER_MAX_SECONDS));
  const total = Math.max(0, (info.seconds ?? cap) - startSeconds);
  const dur = Math.max(0.5, Math.min(cap, total || cap));
  const fadeOut = Math.max(0, dur - 0.12).toFixed(2);
  // Áudio mais longo pede bitrate menor pra caber no limite.
  const bitrates = dur > 20 ? ["32k", "24k", "16k"] : dur > 12 ? ["40k", "32k", "24k"] : ["48k", "32k", "24k"];
  for (const bitrate of bitrates) {
    const out = outFile(outputDir, inputPath, "som", "ogg");
    const r = await runFfmpegAsync([
      ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
      "-i", inputPath,
      "-t", dur.toFixed(2),
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", "48000",
      "-af", `afade=t=in:d=0.02,afade=t=out:st=${fadeOut}:d=0.12`,
      "-c:a", "libopus", "-b:a", bitrate, "-application", "audio",
      "-map_metadata", "-1", "-f", "ogg", out
    ]);
    if (!r.ok || !existsSync(out)) continue;
    if (statSync(out).size <= AUDIO_MAX_BYTES) return { path: out, seconds: dur };
  }
  return null;
}

/** Figurinha estática vira animada (mesma imagem em loop) — o zap só toca som em animada. */
export async function staticWebpToAnimated(webpPath, outputDir, seconds = 3) {
  const out = outFile(outputDir, webpPath, "anim", "webp");
  const r = await runFfmpegAsync([
    "-loop", "1", "-i", webpPath,
    "-t", String(Math.max(1, Math.min(SOUND_STICKER_HARD_MAX_SECONDS, seconds))),
    "-vf", "fps=2,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=0x00000000,format=yuva420p",
    "-c:v", "libwebp", "-lossless", "0", "-quality", "75", "-loop", "0", "-an", "-f", "webp", out
  ]);
  return r.ok && existsSync(out) ? out : null;
}

const MP4_OUT = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "3.1"];
const MP4_AUDIO = ["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"];

/** MP4 (vídeo da figurinha) + áudio: o vídeo repete até o som acabar. */
export async function muxAudioIntoMp4(videoPath, audioPath, outputDir) {
  const out = outFile(outputDir, videoPath, "comsom", "mp4");
  const r = await runFfmpegAsync([
    "-stream_loop", "-1", "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    ...MP4_OUT, ...MP4_AUDIO,
    "-shortest", out
  ]);
  return r.ok && existsSync(out) ? out : null;
}

/**
 * Figurinha com som → MP4 direto (sem passar por GIF): o sharp decodifica os quadros do webp
 * (o ffmpeg daqui não lê webp animado), manda cru pro ffmpeg e ele junta com o áudio num passo só.
 * Estática vira imagem parada pelo tempo do som. Se o vídeo for mais curto que o som, ele repete.
 */
export async function soundStickerToMp4(stickerPath, audioPath, outputDir) {
  const meta = await sharp(stickerPath, { animated: true, limitInputPixels: false }).metadata();
  const pages = Math.max(1, Number(meta.pages ?? 1));
  const audioSecs = (await probeMedia(audioPath)).seconds ?? 3;
  const out = outFile(outputDir, stickerPath, "comsom", "mp4");

  if (pages <= 1) {
    const png = await sharp(stickerPath).flatten({ background: "#ffffff" }).png().toBuffer();
    const r = await runFfmpegAsync([
      "-f", "image2pipe", "-c:v", "png", "-framerate", "2", "-i", "pipe:0",
      "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", "loop=loop=-1:size=1:start=0,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-r", "2", ...MP4_OUT, ...MP4_AUDIO,
      "-t", audioSecs.toFixed(2), "-shortest", out
    ], { input: png });
    return r.ok && existsSync(out) ? out : null;
  }

  const width = meta.width;
  const height = meta.pageHeight ?? Math.round(meta.height / pages);
  const delays = Array.isArray(meta.delay) && meta.delay.length ? meta.delay : [];
  const avgDelay = delays.length ? delays.reduce((a, b) => a + (b > 0 ? b : 100), 0) / delays.length : 100;
  const fps = Math.max(1, Math.min(30, Math.round(1000 / avgDelay)));
  const raw = await sharp(stickerPath, { animated: true, pages: -1, limitInputPixels: false })
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer();
  const frames = Math.max(1, Math.floor(raw.length / (width * height * 3)));
  const videoSecs = frames / fps;
  // Repete os quadros até cobrir o som (stream_loop não funciona com stdin).
  const loops = Math.max(1, Math.min(20, Math.ceil(audioSecs / Math.max(0.1, videoSecs))));
  const input = loops > 1 ? Buffer.concat(Array.from({ length: loops }, () => raw)) : raw;
  const r = await runFfmpegAsync([
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "pipe:0",
    "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    ...MP4_OUT, ...MP4_AUDIO,
    "-t", audioSecs.toFixed(2), "-shortest", out
  ], { input });
  return r.ok && existsSync(out) ? out : null;
}
