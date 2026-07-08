import { assertPlatformMatchesCommand } from "../../core/media/urlPlatformDetect.js";
import {
  DOWNLOAD_QUALITIES,
  normalizeDownloadQuality
} from "../../core/media/downloadQuality.js";

const URL_RE = /^https?:\/\//i;
const MODES = new Set(["mp3", "mp4", "post", "user", "banner"]);

const COMMAND_ALIASES = Object.freeze({
  yt: "youtube",
  x: "twitter",
  tt: "twitter",
  insta: "instagram",
  rd: "reddit",
  tk: "tiktok",
  ttok: "tiktok",
  fb: "facebook",
  dl: "download",
  baixar: "download",
  thumb: "thumbnail"
});

export const URL_DOWNLOAD_COMMANDS = Object.freeze([
  "youtube",
  "twitter",
  "instagram",
  "reddit",
  "tiktok",
  "facebook",
  "download",
  "thumbnail"
]);

export function normalizeUrlDownloadCommand(command) {
  const raw = String(command ?? "").toLowerCase();
  return COMMAND_ALIASES[raw] ?? raw;
}

export function isUrlCommand(command) {
  return URL_DOWNLOAD_COMMANDS.includes(normalizeUrlDownloadCommand(command));
}

function findUrlInArgs(args = []) {
  for (const arg of args) {
    const s = String(arg ?? "").trim();
    if (URL_RE.test(s)) return s;
  }
  return null;
}

function findModeInArgs(args = []) {
  for (const arg of args) {
    const token = String(arg ?? "").trim().toLowerCase();
    if (MODES.has(token)) return token;
  }
  return null;
}

function findQualityInArgs(args = []) {
  for (const arg of args) {
    const token = String(arg ?? "").trim().toLowerCase();
    if (DOWNLOAD_QUALITIES.includes(token)) return token;
    const normalized = normalizeDownloadQuality(token, { defaultQuality: null });
    if (normalized) return normalized;
  }
  return null;
}

const DEFAULT_MODE_BY_COMMAND = Object.freeze({
  youtube: "mp4",
  twitter: "post",
  instagram: "post",
  reddit: "post",
  tiktok: "mp4",
  facebook: "post",
  download: "post",
  thumbnail: "post"
});

export function parseUrlDownloadArgs(command, args = []) {
  const normalized = normalizeUrlDownloadCommand(command);
  if (!URL_DOWNLOAD_COMMANDS.includes(normalized)) {
    return { error: `Comando de URL desconhecido: ${command}` };
  }
  const url = findUrlInArgs(args);
  if (!url) {
    return {
      error: "Manda o link depois do comando, ex.: .youtube https://youtu.be/xxx mp3"
    };
  }
  const platformError = assertPlatformMatchesCommand(url, normalized);
  if (platformError) return { error: platformError };

  let mode = findModeInArgs(args);
  if (!mode) {
    mode = DEFAULT_MODE_BY_COMMAND[normalized] ?? "post";
  }

  const qualityToken = findQualityInArgs(args);
  if (qualityToken === null) {
    for (const arg of args) {
      const token = String(arg ?? "").trim().toLowerCase();
      if (!token || URL_RE.test(token) || MODES.has(token)) continue;
      if (normalizeDownloadQuality(token, { defaultQuality: null }) === null) {
        return {
          error: `Qualidade invalida: ${arg}. Use full, mid ou low (ex.: .yt <link> mp4 mid)`
        };
      }
    }
  }

  if (normalized === "thumbnail" && mode !== "post") {
    return { error: "thumbnail/thumb nao aceita modo mp3/mp4 — so o link do YouTube." };
  }

  if (normalized === "thumbnail" && qualityToken) {
    return { error: "thumbnail/thumb nao aceita qualidade — so o link do YouTube." };
  }

  return {
    command: normalized,
    url,
    mode,
    quality: qualityToken ?? "full",
    error: null
  };
}
