import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedBinaryPath = null;
let cachedFfmpegDir = null;

function resolveFfmpegLocation() {
  if (cachedFfmpegDir) return cachedFfmpegDir;
  const envPath = String(process.env.TETOS_FFMPEG_PATH ?? process.env.FFMPEG_LOCATION ?? "").trim();
  if (envPath && existsSync(envPath)) {
    cachedFfmpegDir = envPath;
    return envPath;
  }
  try {
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    const ffmpegPath = ffmpegInstaller?.path;
    if (ffmpegPath && existsSync(ffmpegPath)) {
      cachedFfmpegDir = dirname(ffmpegPath);
      return cachedFfmpegDir;
    }
  } catch {
    /* sem bundle local */
  }
  return null;
}

function withFfmpegLocation(args = []) {
  if (args.some((arg) => arg === "--ffmpeg-location")) return args;
  const ffmpegDir = resolveFfmpegLocation();
  if (!ffmpegDir) return args;
  return ["--ffmpeg-location", ffmpegDir, ...args];
}

const VIDEO_EXTS = [".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi"];
const AUDIO_EXTS = [".mp3", ".m4a", ".opus", ".ogg", ".wav", ".flac", ".aac"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif"];
const AVOID_EXTS = new Set([".webp", ".html", ".json", ".part", ".ytdl"]);

export function resolveYtDlpBinary(customPath = null) {
  if (customPath && existsSync(customPath)) return customPath;
  if (cachedBinaryPath && existsSync(cachedBinaryPath)) return cachedBinaryPath;
  try {
    const youtubedl = require("youtube-dl-exec");
    const bin = youtubedl.constants?.YOUTUBE_DL_PATH ?? youtubedl.YOUTUBE_DL_PATH;
    if (bin && existsSync(bin)) {
      cachedBinaryPath = bin;
      return bin;
    }
  } catch {
    /* fallback abaixo */
  }
  return "yt-dlp";
}

function listRecentFiles(dir, { sinceMs = 0 } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile() || st.mtimeMs < sinceMs) continue;
      out.push({ path: full, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* skip */
    }
  }
  return out;
}

function pickNonEmpty(files = []) {
  return files.filter((f) => f.size > 0);
}

function resolveDownloadPath(outputDir, filePath) {
  if (!filePath) return null;
  if (isAbsolute(filePath)) return filePath;
  return resolve(outputDir, filePath);
}

function parsePrintedFilePath(stdout = "", outputDir = ".") {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = resolveDownloadPath(outputDir, lines[i]);
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export function findPreferredDownloadFile(dir, { sinceMs = 0, mode = "post" } = {}) {
  const recent = pickNonEmpty(listRecentFiles(dir, { sinceMs }));
  const files = recent.filter(
    (f) => !AVOID_EXTS.has(f.path.slice(f.path.lastIndexOf(".")).toLowerCase())
  );

  const allowedExts =
    mode === "mp3"
      ? AUDIO_EXTS
      : mode === "user" || mode === "banner"
        ? [".jpg", ".jpeg", ".png", ...IMAGE_EXTS]
        : mode === "mp4"
          ? [...VIDEO_EXTS, ".gif"]
          : [...VIDEO_EXTS, ".gif", ...IMAGE_EXTS, ...AUDIO_EXTS];

  const pickFrom = (candidates = []) => {
    for (const ext of allowedExts) {
      const matches = candidates
        .filter((f) => f.path.toLowerCase().endsWith(ext))
        .sort((a, b) => b.size - a.size || b.mtime - a.mtime);
      if (matches[0]) return matches[0].path;
    }
    return null;
  };

  if (!files.length) {
    const picked = pickFrom(pickNonEmpty(listRecentFiles(dir, { sinceMs })));
    return picked;
  }

  const picked = pickFrom(files);
  if (picked) return picked;

  const loose = pickFrom(
    files.filter((f) => !f.path.toLowerCase().endsWith(".webp"))
  );
  return loose;
}

export function runYtDlp(
  args = [],
  { binaryPath = null, outputDir = ".", timeoutMs = 120000, mode = "post" } = {}
) {
  return new Promise((resolvePromise, reject) => {
    const bin = resolveYtDlpBinary(binaryPath);
    const workDir = resolve(outputDir);
    mkdirSync(workDir, { recursive: true });
    const startedAt = Date.now();
    const hasPrintFlag = args.some((arg) => String(arg).includes("after_move:filepath"));
    const baseArgs = hasPrintFlag ? args : ["--print", "after_move:filepath", ...args];
    const execArgs = withFfmpegLocation(baseArgs);
    const child = spawn(bin, execArgs, {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let stdout = "";
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`yt-dlp timeout apos ${timeoutMs}ms`));
          }, timeoutMs)
        : null;
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`yt-dlp nao encontrado (${bin}): ${err.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" ");
        reject(new Error(tail || `yt-dlp saiu com codigo ${code}`));
        return;
      }
      const printed = parsePrintedFilePath(stdout, workDir);
      const file =
        (printed && statSync(printed).size > 0 ? printed : null) ??
        findPreferredDownloadFile(workDir, { sinceMs: startedAt - 3000, mode }) ??
        findPreferredDownloadFile(workDir, { mode });
      if (!file || !existsSync(file) || statSync(file).size < 1) {
        reject(new Error("yt-dlp concluiu mas nenhum arquivo foi gerado"));
        return;
      }
      resolvePromise({ path: file, stderr, stdout });
    });
  });
}

export async function fetchUrlToFile(url, destPath, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, buf);
    return destPath;
  } finally {
    clearTimeout(timer);
  }
}

export function safeUnlink(path) {
  try {
    if (path && existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}
