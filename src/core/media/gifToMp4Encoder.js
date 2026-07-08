import { existsSync, readFileSync, renameSync, statSync, unlinkSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const MIN_MP4_BYTES = 320;

/** libx264 + yuv420p exige dimensões pares — evita vídeo em branco no cliente. */
const GIF_TO_MP4_VF = "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos";

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

export function looksLikeGifFile(filePath) {
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
    if (st.size < MIN_MP4_BYTES) return false;
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

export function mp4OkForPlayback(filePath) {
  if (!looksLikeMp4File(filePath)) return { ok: false };
  if (!mp4PassesFfmpegDecode(filePath)) return { ok: false };
  return { ok: true, seconds: probeMp4DurationSecondsRounded(filePath) };
}

/** Copia MP4 já válido e aplica mux de áudio silencioso para reprodução no WhatsApp. */
export function prepareMp4ForWaPlayback(srcPath, dstPath) {
  if (resolve(srcPath) !== resolve(dstPath)) {
    copyFileSync(srcPath, dstPath);
  }
  sealMp4ForMobile(dstPath);
  const probe = mp4OkForPlayback(dstPath);
  if (!probe.ok) {
    throw new Error("mp4 invalido apos preparacao para whatsapp");
  }
  return probe;
}

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
    { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  );
  return r.status === 0 && existsSync(dstPath);
}

function sealMp4ForMobile(mp4Path) {
  const tmp = mp4Path.replace(/\.mp4$/i, ".wa-aud.mp4");
  if (!muxSilentAacIntoMp4Sync(mp4Path, tmp)) {
    try {
      unlinkSync(tmp);
    } catch {}
    return false;
  }
  if (!mp4OkForPlayback(tmp).ok) {
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

async function tryEncodeGifToMp4(gifPath, outputMp4, extraOutputOptions) {
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
        ...extraOutputOptions,
        "-profile:v",
        "baseline",
        "-level",
        "3.1"
      ])
      .save(outputMp4)
  );
  return mp4OkForPlayback(outputMp4);
}

/**
 * Converte GIF animado para MP4 reproduzível (WhatsApp e players comuns).
 * Tenta vários perfis de compressão até obter arquivo decodificável.
 */
export async function encodeGifToMp4(gifPath, outputMp4, { maxDurationSec = 30 } = {}) {
  if (!looksLikeGifFile(gifPath)) {
    throw new Error("arquivo de entrada nao parece ser um GIF animado");
  }

  const durationCap = ["-t", String(Math.max(1, maxDurationSec))];
  const attempts = [
    ["-vf", GIF_TO_MP4_VF, "-crf", "26", "-preset", "fast", ...durationCap],
    ["-vf", "fps=12,scale=480:-2:flags=lanczos", "-crf", "28", "-preset", "fast", ...durationCap],
    ["-vf", "fps=10,scale=400:-2:flags=lanczos", "-crf", "30", "-preset", "veryfast", ...durationCap],
    ["-vf", "fps=10,scale=360:-2:flags=lanczos", "-crf", "32", "-preset", "veryfast", ...durationCap],
    ["-vf", "fps=8,scale=320:-2:flags=lanczos", "-crf", "34", "-preset", "veryfast", ...durationCap],
    ["-vf", "fps=6,scale=288:-2:flags=lanczos", "-crf", "36", "-preset", "veryfast", ...durationCap]
  ];

  for (const extra of attempts) {
    try {
      const probe = await tryEncodeGifToMp4(gifPath, outputMp4, extra);
      if (probe.ok) {
        sealMp4ForMobile(outputMp4);
        const finalProbe = mp4OkForPlayback(outputMp4);
        const result = finalProbe.ok ? finalProbe : probe;
        // #region agent log
        fetch("http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "20737f" },
          body: JSON.stringify({
            sessionId: "20737f",
            hypothesisId: "H3",
            location: "gifToMp4Encoder.js:encode-success",
            message: "gif encode attempt ok",
            data: {
              outSize: existsSync(outputMp4) ? statSync(outputMp4).size : 0,
              seconds: result.seconds,
              attempt: extra.join(" ").slice(0, 120)
            },
            timestamp: Date.now()
          })
        }).catch(() => {});
        // #endregion
        return result;
      }
    } catch {
      /* próxima tentativa */
    }
  }

  throw new Error("falha ao converter GIF animado para MP4");
}

/** Reaplica selagem WA num MP4 já gerado (ex.: após reencode). */
export function sealExistingMp4InPlace(mp4Path) {
  sealMp4ForMobile(mp4Path);
  return mp4OkForPlayback(mp4Path);
}
