import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Edição de mídia que chegou no chat (o Convenus corta/faz GIF de LINK; arquivo do chat é aqui, com
 * o ffmpeg local): cortar trecho e vídeo → GIF.
 */

const AUDIO_EXT = new Set([".mp3", ".m4a", ".ogg", ".opus", ".wav", ".flac", ".aac", ".oga"]);

function run(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

function probe(path) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(path, (err, data) => resolve(err ? null : data));
  });
}

export async function mediaDuration(path) {
  const data = await probe(path);
  return Number(data?.format?.duration) || 0;
}

function stamp() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** É áudio (sem vídeo)? */
export async function isAudioOnly(path, type = null) {
  if (["audio", "ptt", "voice"].includes(type)) return true;
  if (AUDIO_EXT.has(extname(path).toLowerCase())) return true;
  const data = await probe(path);
  return Boolean(data?.streams?.length) && !data.streams.some((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
}

/**
 * Corta [start, end] (segundos; end 0 = até o fim). Vídeo sai MP4 (H.264/AAC), áudio sai MP3.
 * Devolve { path, kind, mimetype, fileName, start, end }.
 */
export async function trimMedia(inputPath, { start = 0, end = 0 } = {}, outputDir, { type = null, toAudio = false } = {}) {
  if (!existsSync(inputPath)) throw new Error("arquivo não encontrado");
  const duration = await mediaDuration(inputPath);
  if (duration && start >= duration) throw new Error(`o arquivo só tem ${Math.floor(duration)} s`);
  const stop = end && duration ? Math.min(end, duration) : end;
  const audio = toAudio || (await isAudioOnly(inputPath, type));
  mkdirSync(outputDir, { recursive: true });
  const base = basename(inputPath, extname(inputPath)).slice(0, 40);
  const out = join(outputDir, `${base}-corte-${stamp()}.${audio ? "mp3" : "mp4"}`);
  const cmd = ffmpeg(inputPath).setStartTime(start);
  if (stop) cmd.setDuration(Math.max(0.2, stop - start));
  if (audio) {
    cmd.noVideo().audioCodec("libmp3lame").audioBitrate("192k").toFormat("mp3");
  } else {
    cmd.outputOptions(["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]).toFormat("mp4");
  }
  await run(cmd.save(out));
  if (!existsSync(out) || statSync(out).size < 1) throw new Error("o corte não gerou arquivo");
  return {
    path: out,
    kind: audio ? "audio" : "video",
    mimetype: audio ? "audio/mpeg" : "video/mp4",
    fileName: `corte.${audio ? "mp3" : "mp4"}`,
    start,
    end: stop || duration || 0,
    sizeBytes: statSync(out).size
  };
}

/** Vídeo/GIF → GIF de verdade (paleta própria, até 60 s). */
export async function videoToGif(inputPath, { start = 0, end = 0, fps = 15, width = 480 } = {}, outputDir) {
  if (!existsSync(inputPath)) throw new Error("arquivo não encontrado");
  const duration = await mediaDuration(inputPath);
  const stop = end ? (duration ? Math.min(end, duration) : end) : Math.min(duration || 6, start + 6);
  if (stop - start > 60.05) throw new Error("GIF só até 60 segundos, escolhe um trecho menor");
  mkdirSync(outputDir, { recursive: true });
  const base = basename(inputPath, extname(inputPath)).slice(0, 40);
  const out = join(outputDir, `${base}-gif-${stamp()}.gif`);
  const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=256[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const cmd = ffmpeg(inputPath).setStartTime(start).setDuration(Math.max(0.2, stop - start)).outputOptions(["-filter_complex", filter, "-loop", "0", "-an"]);
  await run(cmd.save(out));
  if (!existsSync(out) || statSync(out).size < 1) throw new Error("o GIF não saiu");
  return { path: out, kind: "gif", mimetype: "image/gif", fileName: "teto.gif", start, end: stop, sizeBytes: statSync(out).size };
}
