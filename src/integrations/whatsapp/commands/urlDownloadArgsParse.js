import { detectPlatform } from "../../../core/media/urlPlatformDetect.js";
import { normalizeDownloadQuality } from "../../../core/media/downloadQuality.js";

const URL_RE = /^https?:\/\//i;
const MODES = new Set(["mp3", "mp4", "wav", "post", "user", "banner"]);
const MODE_ALIASES = Object.freeze({ audio: "mp3", musica: "mp3", "música": "mp3", video: "mp4", "vídeo": "mp4", foto: "post", fotos: "post", perfil: "user", capa: "banner" });
const BITRATES = new Set(["128", "192", "256", "320"]);
const HEIGHT_RE = /^(?:(\d{3,4})p?|4k|2k)$/i;
const LANG_RE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;

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

const URL_DOWNLOAD_COMMANDS = Object.freeze([
  "youtube",
  "twitter",
  "instagram",
  "reddit",
  "tiktok",
  "facebook",
  "download",
  "thumbnail",
  "mp3",
  "legenda",
  "linkinfo"
]);

const DEFAULT_MODE_BY_COMMAND = Object.freeze({
  youtube: "mp4",
  twitter: "post",
  instagram: "post",
  reddit: "post",
  tiktok: "mp4",
  facebook: "post",
  download: "post",
  thumbnail: "post",
  mp3: "mp3",
  legenda: "srt",
  linkinfo: "info"
});

const PLATFORM_LABEL = { youtube: "YouTube", twitter: "X", instagram: "Instagram", reddit: "Reddit", tiktok: "TikTok", facebook: "Facebook" };

function normalizeUrlDownloadCommand(command) {
  const raw = String(command ?? "").toLowerCase();
  return COMMAND_ALIASES[raw] ?? raw;
}

/** Link no meio dos argumentos (WhatsApp às vezes cola "<link>" ou texto junto). */
function findUrlInArgs(args = []) {
  for (const arg of args) {
    const s = String(arg ?? "").trim().replace(/^[<(["']+|[>)\]"',]+$/g, "");
    if (URL_RE.test(s)) return s;
  }
  return null;
}

function heightOf(token) {
  const m = HEIGHT_RE.exec(token);
  if (!m) return null;
  if (/^4k$/i.test(token)) return "2160";
  if (/^2k$/i.test(token)) return "1440";
  const h = Number(m[1]);
  return h >= 144 && h <= 4320 ? String(h) : null;
}

/**
 * Lê "<link> [modo] [qualidade]" (em qualquer ordem). Qualidade: full|mid|low (alta/média/baixa),
 * altura do vídeo (720, 1080p, 4k) ou kbps do mp3 (128–320). Link de outra plataforma não é erro:
 * o conversor baixa de qualquer site, então só vira download genérico.
 */
export function parseUrlDownloadArgs(command, args = []) {
  const requested = normalizeUrlDownloadCommand(command);
  if (!URL_DOWNLOAD_COMMANDS.includes(requested)) {
    return { error: `Comando de link desconhecido: ${command}` };
  }
  const url = findUrlInArgs(args);
  if (!url) {
    const example = requested === "mp3" ? ".mp3 https://youtu.be/xxx" : requested === "legenda" ? ".legenda https://youtu.be/xxx pt" : `.${requested} https://link`;
    return { error: `Manda o link depois do comando, ex.: ${example}` };
  }

  let normalized = requested;
  let platformNote = null;
  const expected = PLATFORM_LABEL[requested] ? requested : null;
  const detected = detectPlatform(url);
  if (expected && detected !== "generic" && detected !== expected) {
    normalized = "download";
    platformNote = `esse link é do ${PLATFORM_LABEL[detected] ?? detected}, baixei como download normal`;
  }

  let mode = null;
  let quality = null;
  let lang = null;
  for (const arg of args) {
    const raw = String(arg ?? "").trim();
    const token = raw.toLowerCase();
    if (!token || URL_RE.test(raw) || raw.includes(url)) continue;
    if (MODES.has(token) || MODE_ALIASES[token]) {
      mode = MODE_ALIASES[token] ?? token;
      continue;
    }
    if (requested === "legenda" && LANG_RE.test(token)) {
      lang = token;
      continue;
    }
    const q = normalizeDownloadQuality(token, { defaultQuality: null });
    if (q) {
      quality = q;
      continue;
    }
    if (BITRATES.has(token.replace(/kbps$/, ""))) {
      quality = token.replace(/kbps$/, "");
      if (!mode && requested !== "mp3") mode = "mp3";
      continue;
    }
    const h = heightOf(token);
    if (h) {
      quality = h;
      continue;
    }
    if (requested === "linkinfo") continue;
    return { error: `Não entendi "${raw}". Qualidade: full, mid ou low (ou 720, 1080, 320kbps). Ex.: .yt <link> mp4 720` };
  }

  if (requested === "thumbnail" && (mode || quality)) {
    return { error: "thumbnail/thumb não aceita formato nem qualidade, só o link." };
  }
  if (requested === "mp3") mode = mode === "wav" ? "wav" : "mp3";

  return {
    command: normalized,
    url,
    mode: requested === "legenda" ? "srt" : requested === "linkinfo" ? "info" : mode ?? DEFAULT_MODE_BY_COMMAND[normalized] ?? "post",
    quality: quality ?? "full",
    lang,
    platformNote,
    error: null
  };
}
