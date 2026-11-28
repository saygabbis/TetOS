/** ffmpeg da figurinha com som: áudio Opus curto, figurinha estática → animada, toimg com som. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

/** Limites que o zap aceita bem (os bots da comunidade usam ~10 s e ~256 KB). */
export const SOUND_STICKER_MAX_SECONDS = 10;
const AUDIO_MAX_BYTES = 250 * 1024;

function run(args) {
  const r = spawnSync(ffmpegInstaller.path, ["-y", "-nostdin", "-hide_banner", ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });
  return { ok: r.status === 0, stderr: String(r.stderr ?? "") };
}

function outFile(dir, input, suffix, ext) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${basename(input, extname(input))}-${suffix}-${Date.now()}.${ext}`);
}

/** Duração (s) e se tem trilha de áudio, lendo o stderr do ffmpeg -i. */
export function probeMedia(path) {
  const r = run(["-i", path]);
  const m = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  return { seconds, hasAudio: /Stream #.*Audio:/.test(r.stderr) };
}

/**
 * Extrai/converte áudio pra Ogg/Opus mono 48 kHz, até `maxSeconds`. Retorna { path, seconds } ou
 * null se não tem áudio (ou é só silêncio).
 */
export function extractStickerAudio(inputPath, outputDir, { maxSeconds = SOUND_STICKER_MAX_SECONDS, startSeconds = 0 } = {}) {
  const info = probeMedia(inputPath);
  if (!info.hasAudio) return null;
  const total = Math.max(0, (info.seconds ?? maxSeconds) - startSeconds);
  const dur = Math.max(0.5, Math.min(maxSeconds, total || maxSeconds));
  const fadeOut = Math.max(0, dur - 0.12).toFixed(2);
  for (const bitrate of ["48k", "32k", "24k"]) {
    const out = outFile(outputDir, inputPath, "som", "ogg");
    const r = run([
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
export function staticWebpToAnimated(webpPath, outputDir, seconds = 3) {
  const out = outFile(outputDir, webpPath, "anim", "webp");
  const r = run([
    "-loop", "1", "-i", webpPath,
    "-t", String(Math.max(1, Math.min(SOUND_STICKER_MAX_SECONDS, seconds))),
    "-vf", "fps=2,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=0x00000000,format=yuva420p",
    "-c:v", "libwebp", "-lossless", "0", "-quality", "75", "-loop", "0", "-an", "-f", "webp", out
  ]);
  return r.ok && existsSync(out) ? out : null;
}

/** MP4 (vídeo da figurinha) + áudio: o vídeo repete até o som acabar. */
export function muxAudioIntoMp4(videoPath, audioPath, outputDir) {
  const out = outFile(outputDir, videoPath, "comsom", "mp4");
  const r = run([
    "-stream_loop", "-1", "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level", "3.1",
    "-c:a", "aac", "-b:a", "96k",
    "-shortest", "-movflags", "+faststart", out
  ]);
  return r.ok && existsSync(out) ? out : null;
}
