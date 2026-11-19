import { detectPlatform } from "../../../core/media/urlPlatformDetect.js";
import { normalizeDownloadQuality } from "../../../core/media/downloadQuality.js";

/**
 * Lê os argumentos dos comandos de link (em qualquer ordem):
 *   <link> [mp3|mp4|wav|gif|post] [full|mid|low|720|1080p|4k|320kbps]
 *   trecho: 1:20-2:05 · 1:20 2:05 · 90s · 1m30s      (no .cortar/.gif número solto também é segundo)
 *   legenda dentro do vídeo: leg · leg:pt · legendado
 *   tamanho máximo: 8mb (comprime se passar)
 *   gif: 15fps · 480px
 *   .playlist: 1-5 · 1,3,7 · 3 · todas
 *   .perfil: foto | capa | <seção> [quantos]
 */

const URL_RE = /^https?:\/\//i;
const MODES = new Set(["mp3", "mp4", "wav", "gif", "post", "user", "banner"]);
const MODE_ALIASES = Object.freeze({ audio: "mp3", "áudio": "mp3", musica: "mp3", "música": "mp3", video: "mp4", "vídeo": "mp4", foto: "post", fotos: "post", imagem: "post", imagens: "post" });
const BITRATES = new Set(["128", "192", "256", "320"]);
const HEIGHT_RE = /^(?:(\d{3,4})p?|4k|2k)$/i;
const LANG_RE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;
const FILLER = new Set(["a", "até", "ate", "ao", "de", "do", "da", "e", "-", "–", "em", "no", "na", "por", "pra", "para", "trecho", "qualidade"]);

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
  "thumbnail",
  "mp3",
  "legenda",
  "linkinfo",
  "cortar",
  "gif",
  "playlist",
  "perfil"
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
  linkinfo: "info",
  cortar: "mp4",
  gif: "gif",
  playlist: "mp3",
  perfil: "info"
});

const EXAMPLES = Object.freeze({
  mp3: ".mp3 https://youtu.be/xxx",
  legenda: ".legenda https://youtu.be/xxx pt",
  cortar: ".cortar https://youtu.be/xxx 1:20 1:45",
  gif: ".gif https://youtu.be/xxx 0:10 0:16",
  playlist: ".playlist https://youtube.com/playlist?list=xxx 1-5",
  perfil: ".perfil https://instagram.com/fulano"
});

const PLATFORM_LABEL = { youtube: "YouTube", twitter: "X", instagram: "Instagram", reddit: "Reddit", tiktok: "TikTok", facebook: "Facebook" };

const PROFILE_AVATAR = new Set(["avatar", "foto", "pfp", "icone", "ícone", "icon", "fotodeperfil", "perfil"]);
const PROFILE_BANNER = new Set(["banner", "capa", "header", "fundo", "cover"]);
const ALL_WORDS = new Set(["todas", "todos", "tudo", "all", "inteira", "inteiro"]);

function normalizeUrlDownloadCommand(command) {
  const raw = String(command ?? "").toLowerCase();
  return COMMAND_ALIASES[raw] ?? raw;
}

function cleanToken(arg) {
  return String(arg ?? "").trim().replace(/^[<(["']+|[>)\]"',]+$/g, "");
}

/** Link no meio dos argumentos (WhatsApp às vezes cola "<link>" ou texto junto). */
export function findUrlInArgs(args = []) {
  for (const arg of args) {
    const s = cleanToken(arg);
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
 * "1:20" · "01:02:03" · "90s" · "1m30s" · "2m" · "1h2m" · "1:20.5" → segundos.
 * Número solto só vale com `bare: true` (no .cortar/.gif).
 */
export function parseTimeToken(token, { bare = false } = {}) {
  const t = String(token ?? "").trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  let m = /^(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = /^(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(?:(\d+)h)?(?:(\d+)(?:m|min))?(?:(\d+(?:\.\d+)?)(?:s|seg))?$/.exec(t);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  if (bare && /^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return null;
}

/** "1:20-2:05" / "30-45" → { start, end }. */
function parseRange(token, { bare = false } = {}) {
  const parts = String(token ?? "").split(/[-–~]|\.\.|>/);
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const start = parseTimeToken(parts[0], { bare: true });
  const end = parseTimeToken(parts[1], { bare: true });
  if (start == null || end == null) return null;
  // "30-45" sem ":" só é trecho no .cortar/.gif (no .playlist é escolha de faixa).
  if (!bare && !/[:hms]/i.test(token)) return null;
  return { start, end };
}

/** "1-5" · "1,3,7" · "3" → índices a partir de 0. */
function parseSelection(token) {
  const out = [];
  for (const part of String(token ?? "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const r = /^(\d{1,4})\s*[-–]\s*(\d{1,4})$/.exec(p);
    if (r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < 500; i += 1) out.push(i - 1);
      continue;
    }
    if (/^\d{1,4}$/.test(p)) out.push(Number(p) - 1);
    else return null;
  }
  return out.length ? out.filter((i) => i >= 0) : null;
}

export function fmtClock(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = (Number.isInteger(sec) ? String(sec) : sec.toFixed(1)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Lê os argumentos de um comando de link. Link de outra plataforma não é erro: o conversor baixa
 * de qualquer site, então só vira download genérico.
 */
export function parseUrlDownloadArgs(command, args = []) {
  const requested = normalizeUrlDownloadCommand(command);
  if (!URL_DOWNLOAD_COMMANDS.includes(requested)) {
    return { error: `Comando de link desconhecido: ${command}` };
  }
  const url = findUrlInArgs(args);
  if (!url) {
    return { error: `Manda o link depois do comando, ex.: ${EXAMPLES[requested] ?? `.${requested} https://link`}` };
  }

  let normalized = requested;
  let platformNote = null;
  const expected = PLATFORM_LABEL[requested] ? requested : null;
  const detected = detectPlatform(url);
  if (expected && detected !== "generic" && detected !== expected) {
    normalized = "download";
    platformNote = `esse link é do ${PLATFORM_LABEL[detected] ?? detected}, baixei como download normal`;
  }

  const bareTimes = requested === "cortar" || requested === "gif";
  let mode = null;
  let quality = null;
  let lang = null;
  let embedSubs = null;
  let maxMb = null;
  let fps = null;
  let width = null;
  const times = [];
  let selection = null;
  let selectAll = false;
  const profile = { action: "info", section: null, count: null };

  for (const arg of args) {
    const raw = cleanToken(arg);
    const token = raw.toLowerCase();
    if (!token || URL_RE.test(raw) || raw.includes(url)) continue;
    if (FILLER.has(token)) continue;

    // .perfil: foto / capa / seção / quantos
    if (requested === "perfil") {
      if (["info", "infos", "dados", "card", "resumo"].includes(token)) {
        profile.action = "info";
        continue;
      }
      if (PROFILE_AVATAR.has(token)) {
        profile.action = "avatar";
        continue;
      }
      if (PROFILE_BANNER.has(token)) {
        profile.action = "banner";
        continue;
      }
      if (/^\d{1,2}$/.test(token)) {
        profile.count = Math.min(10, Math.max(1, Number(token)));
        if (profile.action === "info") profile.action = "section";
        continue;
      }
    }

    // .playlist: escolha de faixas
    if (requested === "playlist") {
      if (ALL_WORDS.has(token)) {
        selectAll = true;
        continue;
      }
      const sel = /^[\d,\s-]+$/.test(token) && (/[-,]/.test(token) || Number(token) < 100) ? parseSelection(token) : null;
      if (sel) {
        selection = [...(selection ?? []), ...sel];
        continue;
      }
    }

    // legenda gravada no vídeo
    const leg = /^(?:leg|legenda|legendado|legendas|sub|subs|cc)(?:[:=]([a-z]{2,3}(?:-[a-z]{2,4})?))?$/i.exec(token);
    if (leg && requested !== "legenda") {
      embedSubs = leg[1] ?? true;
      continue;
    }

    // tamanho máximo
    const mb = /^(\d+(?:[.,]\d+)?)\s*(mb|m|mega|megas)$/i.exec(token);
    if (mb && !(bareTimes && token.endsWith("m") && !/mb|mega/.test(token))) {
      maxMb = Number(mb[1].replace(",", "."));
      continue;
    }

    // gif: fps e largura
    const f = /^(\d{1,2})\s*fps$/.exec(token);
    if (f) {
      fps = Number(f[1]);
      continue;
    }
    const w = /^(\d{3,4})\s*(px|w)$/.exec(token);
    if (w) {
      width = Number(w[1]);
      continue;
    }

    if (MODES.has(token) || MODE_ALIASES[token]) {
      mode = MODE_ALIASES[token] ?? token;
      continue;
    }
    if (requested === "legenda" && LANG_RE.test(token) && !normalizeDownloadQuality(token, { defaultQuality: null })) {
      lang = token;
      continue;
    }

    // trecho
    const range = parseRange(token, { bare: bareTimes });
    if (range) {
      times.push(range.start, range.end);
      continue;
    }
    if (times.length < 2) {
      const t = parseTimeToken(token, { bare: bareTimes && !/^\d{3,4}p$/i.test(token) });
      if (t != null && (bareTimes || /[:hms]/.test(token)) && !(bareTimes && heightOf(token) && /p$/i.test(token))) {
        times.push(t);
        continue;
      }
    }

    const q = normalizeDownloadQuality(token, { defaultQuality: null });
    if (q) {
      quality = q;
      continue;
    }
    if (BITRATES.has(token.replace(/kbps$/, ""))) {
      quality = token.replace(/kbps$/, "");
      if (!mode && !["mp3", "playlist"].includes(requested)) mode = "mp3";
      continue;
    }
    const h = heightOf(token);
    if (h) {
      quality = h;
      continue;
    }
    if (requested === "perfil" && /^[\p{L}][\p{L}\d_-]{1,20}$/u.test(token)) {
      profile.section = token;
      profile.action = "section";
      continue;
    }
    if (requested === "linkinfo") continue;
    return { error: `Não entendi "${raw}". Qualidade: full, mid ou low (ou 720, 1080, 320kbps). Trecho: 1:20-2:05. Ex.: .yt <link> mp4 720` };
  }

  if (requested === "thumbnail" && (mode || quality)) {
    return { error: "thumbnail/thumb não aceita formato nem qualidade, só o link." };
  }
  if (requested === "mp3") mode = mode === "wav" ? "wav" : "mp3";
  if (requested === "gif") mode = "gif";
  if (requested === "playlist" && mode && !["mp3", "mp4", "wav"].includes(mode)) mode = "mp3";

  let clip = null;
  if (times.length) {
    const [start, end = 0] = times;
    if (end && end <= start) return { error: `o fim do trecho (${fmtClock(end)}) tem que ser depois do começo (${fmtClock(start)})` };
    clip = { start, end };
  }
  if (requested === "cortar" && !clip) {
    return { error: `fala o trecho, ex.: ${EXAMPLES.cortar} (começo e fim)` };
  }
  if (requested === "gif" && clip && clip.end && clip.end - clip.start > 60) {
    return { error: "GIF só até 60 segundos, escolhe um trecho menor" };
  }
  if (requested === "gif" && !clip) clip = { start: 0, end: 6 };

  let gif = null;
  if (mode === "gif") {
    const FPS = [10, 12, 15, 20, 24, 30];
    const WIDTHS = [240, 320, 480, 640, 720];
    gif = {
      fps: fps ? FPS.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a)) : 15,
      width: width ? WIDTHS.reduce((a, b) => (Math.abs(b - width) < Math.abs(a - width) ? b : a)) : 480
    };
  }

  const finalMode =
    requested === "legenda"
      ? "srt"
      : requested === "linkinfo"
        ? "info"
        : requested === "perfil"
          ? mode ?? "post"
          : mode ?? DEFAULT_MODE_BY_COMMAND[normalized] ?? "post";

  return {
    command: normalized,
    url,
    mode: finalMode,
    quality: quality ?? "full",
    lang,
    embedSubs,
    clip,
    gif,
    maxMb,
    selection: requested === "playlist" ? { all: selectAll, indexes: selection ? [...new Set(selection)] : null } : null,
    profile: requested === "perfil" ? profile : null,
    platformNote,
    error: null
  };
}
