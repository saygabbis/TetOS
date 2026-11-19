import { statSync } from "node:fs";
import { extname } from "node:path";
import { trimMedia, videoToGif, mediaDuration } from "./mediaEdit.js";
import { STYLES, fmtSize } from "./linkCommandRunner.js";
import { fmtClock, parseUrlDownloadArgs } from "../../integrations/whatsapp/commands/urlDownloadArgsParse.js";

/**
 * .cortar / .gif / .comprimir numa mídia do chat (a marcada ou anexada), igual no WhatsApp e no
 * Discord. Devolve { text } (aviso/erro) ou { output, caption }.
 */

const MIME = { mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif", gif: "image/gif", pdf: "application/pdf", zip: "application/zip" };

function outputFromPath(path, fallbackName) {
  const ext = extname(path).slice(1).toLowerCase();
  const mimetype = MIME[ext] ?? "application/octet-stream";
  const kind = ext === "gif" ? "gif" : mimetype.startsWith("video/") ? "video" : mimetype.startsWith("audio/") ? "audio" : mimetype.startsWith("image/") ? "image" : "document";
  return { path, kind, mimetype, fileName: `${String(fallbackName).replace(/\.[^.]+$/, "")}.${ext}`, sizeBytes: statSync(path).size };
}

/** Lê "<MB>" do .comprimir: "8", "8mb", "8,5", "500kb". */
export function parseCompressTarget(args = [], fallbackMb = null) {
  for (const a of args ?? []) {
    const t = String(a ?? "").toLowerCase().replace(",", ".");
    const kb = /^(\d+(?:\.\d+)?)\s*kb$/.exec(t);
    if (kb) return Number(kb[1]) / 1024;
    const mb = /^(\d+(?:\.\d+)?)\s*(?:mb|m|mega|megas)?$/.exec(t);
    if (mb) return Number(mb[1]);
  }
  return fallbackMb;
}

/** Trecho/GIF de mídia do chat: ".cortar 0:10 0:30", ".gif 2 5 20fps", ".cortar 1:00-1:30 mp3". */
export function parseMediaEditArgs(args = []) {
  const cut = parseUrlDownloadArgs("cortar", ["https://x", ...(args ?? [])]);
  if (cut.error && !/fala o trecho/.test(cut.error)) return { error: cut.error.replace(/ Ex\.: .*$/, "") };
  const g = parseUrlDownloadArgs("gif", ["https://x", ...(args ?? [])]);
  const userClip = cut.error ? null : cut.clip;
  return { clip: userClip, gif: g.gif ?? { fps: 15, width: 480 }, toAudio: cut.mode === "mp3", error: null };
}

const AV_TYPES = new Set(["video", "audio", "ptt", "voice", "gif"]);

export async function editMediaTarget(command, args, media, { runtime, outputDir = "./data/media/derived", prefix = ".", notify = null, style = STYLES.whatsapp, defaultMb = 8 } = {}) {
  const p = prefix;
  const say = async (t) => notify && (await notify(t));
  const isAV = AV_TYPES.has(media?.type) || /^(audio|video)\//.test(media?.mimetype ?? "");

  if (command === "cortar") {
    if (!isAV) return { text: `isso não é vídeo nem áudio 🤔 responde um vídeo/áudio com ${p}cortar 0:10 0:30` };
    const e = parseMediaEditArgs(args);
    if (e.error) return { text: e.error };
    if (!e.clip) return { text: `fala o trecho: ${p}cortar 0:10 0:30 (começo e fim) · ${p}cortar 1:00-1:30 · ${p}cortar 0:10 0:30 mp3 (só o áudio)` };
    await say(`✂️ cortando ${fmtClock(e.clip.start)} → ${e.clip.end ? fmtClock(e.clip.end) : "o fim"}…`);
    const out = await trimMedia(media.path, e.clip, outputDir, { type: media.type, toAudio: e.toAudio });
    return { output: out, caption: `✅ trecho ${fmtClock(out.start)} → ${fmtClock(out.end)} · ${out.kind === "audio" ? "MP3" : "MP4"} · ${fmtSize(out.sizeBytes)}` };
  }

  if (command === "gif") {
    const isVisual = ["video", "gif"].includes(media?.type) || /^video\//.test(media?.mimetype ?? "") || (media?.type === "sticker" && media?.isAnimated);
    if (!isVisual) return { text: `GIF sai de vídeo 🎞️ responde um vídeo com ${p}gif (ou ${p}gif 2 8 pra um trecho)` };
    const e = parseMediaEditArgs(args);
    if (e.error) return { text: e.error };
    const duration = await mediaDuration(media.path).catch(() => 0);
    const clip = e.clip ?? { start: 0, end: Math.min(duration || 8, 8) };
    if (clip.end && clip.end - clip.start > 60) return { text: "GIF só até 60 segundos, escolhe um trecho menor" };
    await say(`🎞️ fazendo GIF ${fmtClock(clip.start)} → ${fmtClock(clip.end || duration)} · ${e.gif.fps} fps · ${e.gif.width}px…`);
    const out = await videoToGif(media.path, { ...clip, ...e.gif }, outputDir);
    return { output: out, caption: `✅ GIF · ${fmtClock(out.start)} → ${fmtClock(out.end)} · ${e.gif.width}px · ${fmtSize(out.sizeBytes)}${e.clip ? "" : `\n(dica: ${p}gif 2 8 escolhe o trecho · ${p}gif 20fps 320px muda a qualidade)`}` };
  }

  if (command === "comprimir") {
    const convenus = runtime?.convenus;
    if (!convenus?.isConfigured?.()) return { text: "o conversor tá fora do ar agora, tenta daqui a pouco 😕" };
    const mb = parseCompressTarget(args, null);
    const target = mb ?? defaultMb;
    const before = statSync(media.path).size;
    if (before <= target * 1024 * 1024 * 0.98) {
      return { text: `esse arquivo já tem ${fmtSize(before)}, menor que ${String(target).replace(".", ",")} MB 😅${mb ? "" : ` pra deixar menor ainda: ${p}comprimir 2`}` };
    }
    await say(`🗜️ comprimindo ${fmtSize(before)} → até ${String(target).replace(".", ",")} MB…${mb ? "" : ` (padrão; ${p}comprimir 5 escolhe o tamanho)`}`);
    const c = await convenus.compressFile(media.path, target, { name: media.fileName ?? null });
    const out = outputFromPath(c.path, media.fileName ?? `comprimido${extname(c.path)}`);
    const pct = Math.round((1 - out.sizeBytes / before) * 100);
    return { output: out, caption: `✅ ${fmtSize(before)} → ${style.b(fmtSize(out.sizeBytes))} (-${pct}%)` };
  }

  return { text: `não sei fazer ${p}${command} nessa mídia` };
}
