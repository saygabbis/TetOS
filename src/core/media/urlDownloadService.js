import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { extractYouTubeVideoId } from "./urlPlatformDetect.js";
import { fetchUrlToFile, runYtDlp, safeUnlink } from "./ytDlpRunner.js";
import {
  downloadTwitterMediaItems,
  resolveTwitterMediaItems,
  shouldUseTwitterMediaFallback
} from "./twitterMediaFallback.js";
import { audioQualityValue, videoFormatSelector } from "./downloadQuality.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const AUDIO_EXTS = new Set([".mp3", ".m4a", ".opus", ".ogg", ".wav", ".flac", ".aac"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp"]);

const MIME_BY_EXT = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".avi": "video/x-msvideo",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp"
};

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

function extOf(filePath) {
  return extname(String(filePath ?? "")).toLowerCase();
}

function kindFromExt(ext) {
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "document";
}

function buildOutput(filePath, fileName = null) {
  const ext = extOf(filePath);
  const stem = basename(filePath, ext);
  const base = fileName ?? stem;
  const finalName = base.endsWith(ext) ? base : `${base}${ext}`;
  return {
    path: filePath,
    kind: kindFromExt(ext),
    mimetype: MIME_BY_EXT[ext] ?? "application/octet-stream",
    fileName: finalName
  };
}

export function inferDownloadMode(url, mode) {
  const u = String(url ?? "").toLowerCase();
  if (mode === "mp3" || mode === "user" || mode === "banner") return mode;
  if (mode === "mp4") return "mp4";
  if (/\/video\/\d+/i.test(u)) return "mp4";
  if (/v\.redd\.it\//i.test(u)) return "mp4";
  if (/tiktok\.com\/.*\/video\//i.test(u)) return "mp4";
  return "post";
}

function normalizeTwitterUrl(url, mode) {
  const u = String(url ?? "").trim();
  if (mode === "user") {
    const m = u.match(/(?:twitter\.com|x\.com)\/(@?[\w]+)/i);
    if (m) return `https://twitter.com/${m[1].replace(/^@/, "")}/photo`;
  }
  if (mode === "banner") {
    const m = u.match(/(?:twitter\.com|x\.com)\/(@?[\w]+)/i);
    if (m) return `https://twitter.com/${m[1].replace(/^@/, "")}/header_photo`;
  }
  return u;
}

function normalizeInstagramUrl(url, mode) {
  const u = String(url ?? "").trim();
  if (mode === "user") {
    const m = u.match(/instagram\.com\/(@?[\w.]+)/i);
    if (m && !/^(p|reel|tv|stories)\//i.test(m[1])) {
      return `https://www.instagram.com/${m[1].replace(/^@/, "")}/`;
    }
  }
  return u;
}

function normalizeRedditUrl(url, mode) {
  const u = String(url ?? "").trim();
  if (mode === "user") {
    const m = u.match(/reddit\.com\/(?:u|user)\/([\w_-]+)/i);
    if (m) return `https://www.reddit.com/user/${m[1]}/about.json`;
  }
  return u;
}

function baseYtDlpArgs(outTemplate) {
  return [
    "--no-playlist",
    "--no-warnings",
    "--no-write-thumbnail",
    "--no-embed-thumbnail",
    "--force-overwrites",
    "-o",
    outTemplate
  ];
}

function appendVideoFormatArgs(args, quality = "full") {
  args.push(
    "-f",
    videoFormatSelector(quality),
    "--merge-output-format",
    "mp4",
    "--remux-video",
    "mp4"
  );
}

function appendAudioFormatArgs(args, quality = "full") {
  args.push("-x", "--audio-format", "mp3", "--audio-quality", audioQualityValue(quality));
}

function appendProfileImageArgs(args) {
  args.push("--write-thumbnail", "--skip-download", "--convert-thumbnails", "jpg");
}

async function normalizeDownloadFile(filePath, outputDir, mode) {
  const ext = extOf(filePath);
  const stem = basename(filePath, ext);

  if (ext === ".webp") {
    const out = join(outputDir, `${stem}.png`);
    await sharp(filePath).png({ compressionLevel: 6 }).toFile(out);
    safeUnlink(filePath);
    return out;
  }

  if (mode === "mp3" && ext !== ".mp3") {
    const out = join(outputDir, `${stem}.mp3`);
    await runFfmpeg(
      ffmpeg(filePath).noVideo().audioCodec("libmp3lame").toFormat("mp3").save(out)
    );
    if (ext !== ".mp3") safeUnlink(filePath);
    return out;
  }

  if ([".webm", ".mkv", ".mov", ".m4v", ".avi"].includes(ext)) {
    const out = join(outputDir, `${stem}.mp4`);
    await runFfmpeg(
      ffmpeg(filePath)
        .outputOptions(["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"])
        .toFormat("mp4")
        .save(out)
    );
    safeUnlink(filePath);
    return out;
  }

  if ([".m4a", ".opus", ".ogg", ".wav", ".flac", ".aac"].includes(ext) && mode !== "mp4") {
    const out = join(outputDir, `${stem}.mp3`);
    await runFfmpeg(ffmpeg(filePath).audioCodec("libmp3lame").toFormat("mp3").save(out));
    safeUnlink(filePath);
    return out;
  }

  if ([".bmp", ".tiff", ".tif"].includes(ext)) {
    const out = join(outputDir, `${stem}.png`);
    await sharp(filePath).png().toFile(out);
    safeUnlink(filePath);
    return out;
  }

  if (ext === ".jpeg") {
    const out = join(outputDir, `${stem}.jpg`);
    const { renameSync } = await import("node:fs");
    renameSync(filePath, out);
    return out;
  }

  return filePath;
}

async function runDownload(
  url,
  mode,
  { outputDir, binaryPath, timeoutMs, audioOnly = false, quality = "full" } = {}
) {
  mkdirSync(outputDir, { recursive: true });
  const effectiveMode = audioOnly ? "mp3" : inferDownloadMode(url, mode);
  const outTemplate = "dl-%(id)s-%(epoch)s.%(ext)s";
  const args = baseYtDlpArgs(outTemplate);

  if (effectiveMode === "mp3") {
    appendAudioFormatArgs(args, quality);
  } else if (effectiveMode === "mp4") {
    appendVideoFormatArgs(args, quality);
  } else if (effectiveMode === "post" && quality !== "full") {
    appendVideoFormatArgs(args, quality);
  } else if (effectiveMode === "user" || effectiveMode === "banner") {
    appendProfileImageArgs(args);
  }

  args.push(url);
  const result = await runYtDlp(args, {
    binaryPath,
    outputDir,
    timeoutMs,
    mode: effectiveMode
  });

  let finalPath = result.path;
  if (effectiveMode === "user" || effectiveMode === "banner") {
    const thumb = finalPath.replace(/\.[^.]+$/, ".jpg");
    if (existsSync(thumb)) finalPath = thumb;
  }

  finalPath = await normalizeDownloadFile(finalPath, outputDir, effectiveMode);

  if (!existsSync(finalPath) || statSync(finalPath).size < 1) {
    throw new Error("download gerou arquivo vazio ou invalido");
  }

  const ext = extOf(finalPath);
  const label =
    effectiveMode === "mp3"
      ? "audio"
      : kindFromExt(ext) === "image"
        ? "imagem"
        : kindFromExt(ext) === "video"
          ? "video"
          : "download";

  return buildOutput(finalPath, `${label}${ext}`);
}

export class UrlDownloadService {
  constructor({ outputDir = "./data/media/derived", ytDlpPath = null, ytDlpTimeoutMs = 120000 } = {}) {
    this.outputDir = outputDir;
    this.ytDlpPath = ytDlpPath;
    this.ytDlpTimeoutMs = ytDlpTimeoutMs;
  }

  opts() {
    return {
      outputDir: this.outputDir,
      binaryPath: this.ytDlpPath,
      timeoutMs: this.ytDlpTimeoutMs
    };
  }

  async downloadYouTube(url, format = "mp4", quality = "full") {
    const mode = format === "mp3" ? "mp3" : "mp4";
    return runDownload(url, mode, { ...this.opts(), audioOnly: mode === "mp3", quality });
  }

  async downloadTwitterViaFallback(url, dlMode, quality = "full") {
    const { statusId, items } = await resolveTwitterMediaItems(url, dlMode, quality);
    const downloaded = await downloadTwitterMediaItems(items, this.outputDir, statusId);
    const outputs = [];

    for (const file of downloaded) {
      let finalPath = await normalizeDownloadFile(file.path, this.outputDir, dlMode);
      if (!existsSync(finalPath) || statSync(finalPath).size < 1) {
        throw new Error("download gerou arquivo vazio ou invalido");
      }
      const ext = extOf(finalPath);
      const label =
        kindFromExt(ext) === "image"
          ? "imagem"
          : kindFromExt(ext) === "video"
            ? "video"
            : "download";
      outputs.push(buildOutput(finalPath, `${label}${ext}`));
    }

    if (outputs.length === 1) return outputs[0];
    return { outputs, ...outputs[0] };
  }

  async downloadTwitter(url, mode = "post", quality = "full") {
    const normalized = normalizeTwitterUrl(url, mode);
    if (mode === "user" || mode === "banner") {
      return runDownload(normalized, mode, { ...this.opts(), quality });
    }
    const dlMode = mode === "mp3" ? "mp3" : inferDownloadMode(normalized, mode === "mp4" ? "mp4" : "post");
    try {
      return await runDownload(normalized, dlMode, {
        ...this.opts(),
        audioOnly: dlMode === "mp3",
        quality
      });
    } catch (error) {
      if (!shouldUseTwitterMediaFallback(error, dlMode)) throw error;
      return this.downloadTwitterViaFallback(normalized, dlMode, quality);
    }
  }

  async downloadInstagram(url, mode = "post", quality = "full") {
    const normalized = normalizeInstagramUrl(url, mode);
    if (mode === "user") {
      return runDownload(normalized, "user", { ...this.opts(), quality });
    }
    const dlMode = mode === "mp3" ? "mp3" : mode === "mp4" ? "mp4" : "post";
    return runDownload(normalized, dlMode, {
      ...this.opts(),
      audioOnly: dlMode === "mp3",
      quality
    });
  }

  async downloadReddit(url, mode = "post", quality = "full") {
    const normalized = normalizeRedditUrl(url, mode);
    if (mode === "user") {
      return runDownload(url.replace(/\/about\.json$/, ""), "user", { ...this.opts(), quality });
    }
    const dlMode = mode === "mp3" ? "mp3" : inferDownloadMode(normalized, mode === "mp4" ? "mp4" : "post");
    return runDownload(normalized, dlMode, {
      ...this.opts(),
      audioOnly: dlMode === "mp3",
      quality
    });
  }

  async downloadTikTok(url, format = "mp4", quality = "full") {
    const mode = format === "mp3" ? "mp3" : "mp4";
    return runDownload(url, mode, { ...this.opts(), audioOnly: mode === "mp3", quality });
  }

  async downloadFacebook(url, mode = "post", quality = "full") {
    const dlMode = mode === "mp3" ? "mp3" : mode === "mp4" ? "mp4" : "post";
    return runDownload(url, dlMode, {
      ...this.opts(),
      audioOnly: dlMode === "mp3",
      quality
    });
  }

  async downloadGeneric(url, format = "post", quality = "full") {
    const mode = format === "mp3" ? "mp3" : format === "mp4" ? "mp4" : inferDownloadMode(url, "post");
    return runDownload(url, mode, { ...this.opts(), audioOnly: mode === "mp3", quality });
  }

  async downloadYoutubeThumbnail(url) {
    const id = extractYouTubeVideoId(url);
    if (!id) throw new Error("Link do YouTube invalido para thumbnail");
    mkdirSync(this.outputDir, { recursive: true });
    const dest = join(this.outputDir, `thumb-${id}.jpg`);
    const candidates = [
      `https://img.youtube.com/vi/${id}/maxresdefault.jpg`,
      `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${id}/mqdefault.jpg`
    ];
    let lastErr = null;
    for (const thumbUrl of candidates) {
      try {
        safeUnlink(dest);
        await fetchUrlToFile(thumbUrl, dest, { timeoutMs: 20000 });
        if (statSync(dest).size > 1200) {
          return buildOutput(dest, `youtube-thumb-${id}.jpg`);
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("Nao achei thumbnail para esse video");
  }

  async downloadByCommand(command, url, mode = "post", quality = "full") {
    const cmd = String(command ?? "").toLowerCase();
    switch (cmd) {
      case "youtube":
      case "yt":
        return this.downloadYouTube(url, mode, quality);
      case "twitter":
      case "x":
      case "tt":
        return this.downloadTwitter(url, mode, quality);
      case "instagram":
      case "insta":
        return this.downloadInstagram(url, mode, quality);
      case "reddit":
      case "rd":
        return this.downloadReddit(url, mode, quality);
      case "tiktok":
      case "tk":
      case "ttok":
        return this.downloadTikTok(url, mode, quality);
      case "facebook":
      case "fb":
        return this.downloadFacebook(url, mode, quality);
      case "thumbnail":
      case "thumb":
        return this.downloadYoutubeThumbnail(url);
      case "download":
      case "dl":
      case "baixar":
        return this.downloadGeneric(url, mode, quality);
      default:
        throw new Error(`comando de download desconhecido: ${command}`);
    }
  }
}
