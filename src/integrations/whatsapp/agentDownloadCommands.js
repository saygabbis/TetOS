/** Comandos de download por URL do agente — equivalentes aos comandos com "." do WhatsApp. */

import { detectPlatform } from "../../core/media/urlPlatformDetect.js";

export const AGENT_URL_DOWNLOAD_COMMANDS = Object.freeze([
  "youtube",
  "yt",
  "twitter",
  "x",
  "tt",
  "instagram",
  "insta",
  "reddit",
  "rd",
  "tiktok",
  "tk",
  "ttok",
  "facebook",
  "fb",
  "download",
  "dl",
  "baixar",
  "thumbnail",
  "thumb"
]);

export const AGENT_URL_DOWNLOAD_ALIASES = Object.freeze({
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

export const AGENT_URL_DOWNLOAD_COMMAND_PATTERN =
  "youtube|yt|twitter|x|tt|instagram|insta|reddit|rd|tiktok|tk|ttok|facebook|fb|download|dl|baixar|thumbnail|thumb";

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"']+/gi;

const PLATFORM_TO_COMMAND = Object.freeze({
  youtube: "youtube",
  twitter: "twitter",
  instagram: "instagram",
  reddit: "reddit",
  tiktok: "tiktok",
  facebook: "facebook",
  generic: "download"
});

/** Especificação canônica — fonte única para prompt da LLM (espelha urlDownloadArgsParse). */
export const AGENT_URL_DOWNLOAD_PROMPT_SPECS = Object.freeze([
  {
    command: "youtube",
    aliases: ["yt"],
    modes: ["mp3", "mp4"],
    defaultMode: "mp4",
    qualities: true,
    platforms: "YouTube (youtu.be, youtube.com, shorts, music.youtube.com)",
    description: "Baixa áudio ou vídeo de link do YouTube.",
    examples: [
      'youtube("https://youtu.be/abc", "mp3")',
      'yt("https://youtu.be/abc", "mp4", "mid")'
    ]
  },
  {
    command: "twitter",
    aliases: ["x", "tt"],
    modes: ["mp3", "mp4", "post", "user", "banner"],
    defaultMode: "post",
    qualities: true,
    platforms: "X/Twitter (x.com, twitter.com, t.co)",
    description:
      "Baixa mídia de post, áudio/vídeo, foto de perfil (user) ou banner (banner) de link do X/Twitter.",
    examples: [
      'twitter("https://x.com/user/status/123", "post")',
      'x("https://x.com/user/status/123", "mp4", "full")'
    ]
  },
  {
    command: "instagram",
    aliases: ["insta"],
    modes: ["mp3", "mp4", "post", "user"],
    defaultMode: "post",
    qualities: true,
    platforms: "Instagram (instagram.com, instagr.am)",
    description: "Baixa post/reel, áudio/vídeo ou perfil (user) de link do Instagram.",
    examples: [
      'instagram("https://instagram.com/p/abc", "post")',
      'insta("https://instagram.com/reel/abc", "mp4")'
    ]
  },
  {
    command: "reddit",
    aliases: ["rd"],
    modes: ["mp3", "mp4", "post", "user"],
    defaultMode: "post",
    qualities: true,
    platforms: "Reddit (reddit.com, redd.it, v.redd.it)",
    description: "Baixa post/vídeo, áudio/vídeo ou perfil (user) de link do Reddit.",
    examples: [
      'reddit("https://reddit.com/r/a/comments/b/c", "post")',
      'rd("https://v.redd.it/abc", "mp4")'
    ]
  },
  {
    command: "tiktok",
    aliases: ["tk", "ttok"],
    modes: ["mp3", "mp4"],
    defaultMode: "mp4",
    qualities: true,
    platforms: "TikTok (tiktok.com, vm.tiktok.com)",
    description: "Baixa áudio ou vídeo de link do TikTok. Use tiktok/tk/ttok — NÃO use tt (é Twitter).",
    examples: [
      'tiktok("https://tiktok.com/@u/video/1", "mp4")',
      'tk("https://vm.tiktok.com/abc", "mp3")'
    ]
  },
  {
    command: "facebook",
    aliases: ["fb"],
    modes: ["mp3", "mp4", "post"],
    defaultMode: "post",
    qualities: true,
    platforms: "Facebook (facebook.com, fb.watch, fb.com)",
    description: "Baixa post ou áudio/vídeo de link do Facebook.",
    examples: [
      'facebook("https://facebook.com/watch/?v=1", "post")',
      'fb("https://fb.watch/abc", "mp4")'
    ]
  },
  {
    command: "download",
    aliases: ["dl", "baixar"],
    modes: ["mp3", "mp4", "post"],
    defaultMode: "post",
    qualities: true,
    platforms: "Twitch, Vimeo, Pinterest, SoundCloud e outras redes genéricas",
    description:
      "Download genérico quando não há comando dedicado. Prefira o comando específico se o link for de YouTube, X, Instagram, etc.",
    examples: [
      'download("https://vimeo.com/123", "mp4")',
      'baixar("https://twitch.tv/videos/1", "mp3", "low")'
    ]
  },
  {
    command: "thumbnail",
    aliases: ["thumb"],
    modes: [],
    defaultMode: null,
    qualities: false,
    platforms: "Somente links do YouTube",
    description: "Envia a miniatura (capa) de um vídeo do YouTube. Não aceita modo mp3/mp4 nem qualidade.",
    examples: [
      'thumbnail("https://youtu.be/abc")',
      'thumb("https://youtube.com/watch?v=abc")'
    ]
  }
]);

export function extractHttpUrlsFromText(text = "") {
  const matches = String(text ?? "").match(URL_IN_TEXT_RE) ?? [];
  return [
    ...new Set(
      matches.map((url) =>
        url.replace(/[),.;!?]+$/g, "").replace(/[)\]}>]+$/g, "")
      )
    )
  ];
}

export function inferDownloadCommandFromUrl(url = "") {
  const platform = detectPlatform(url);
  return PLATFORM_TO_COMMAND[platform] ?? "download";
}

export function parseAgentCommandArgs(argsRaw = "") {
  const args = [];
  const argRegex = /["']([\s\S]*?)["']/g;
  let argMatch;
  while ((argMatch = argRegex.exec(argsRaw)) !== null) {
    args.push(argMatch[1]);
  }

  const bareUrl = argsRaw.match(/(https?:\/\/[^\s"',)]+)/i);
  if (bareUrl && !args.some((a) => a.includes(bareUrl[1]))) {
    args.unshift(bareUrl[1]);
  }

  const tail = argsRaw
    .replace(/["'][\s\S]*?["']/g, " ")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const token of tail) {
    if (/^https?:\/\//i.test(token)) continue;
    if (!args.includes(token)) args.push(token);
  }
  return args;
}

export function normalizeAgentUrlDownloadCommand(cmd) {
  const raw = String(cmd ?? "").toLowerCase();
  return AGENT_URL_DOWNLOAD_ALIASES[raw] ?? raw;
}

export function isAgentUrlDownloadCommand(cmd) {
  return AGENT_URL_DOWNLOAD_COMMANDS.includes(String(cmd ?? "").toLowerCase());
}

export function buildUrlDownloadAction(command, url, extraArgs = []) {
  const raw = String(command ?? "").toLowerCase();
  if (!isAgentUrlDownloadCommand(raw) || !url) {
    return null;
  }
  const cmd = normalizeAgentUrlDownloadCommand(raw);
  return {
    type: "url_download",
    command: cmd,
    url: String(url).trim(),
    args: Array.isArray(extraArgs) ? extraArgs.filter(Boolean) : []
  };
}

function formatModesList(modes = []) {
  if (!modes.length) return "";
  return modes.map((m) => `"${m}"`).join("|");
}

function formatAliases(aliases = []) {
  if (!aliases.length) return "";
  return `Aliases: ${aliases.map((a) => `${a}(...)`).join(", ")}.`;
}

/** Linhas numeradas dos comandos de download para o prompt da LLM. */
export function buildAgentDownloadCommandsPromptLines({ startNumber = 11 } = {}) {
  const lines = [];
  let n = startNumber;
  for (const spec of AGENT_URL_DOWNLOAD_PROMPT_SPECS) {
    const modesPart = spec.modes.length ? `, ${formatModesList(spec.modes)}` : "";
    const defaultPart = spec.defaultMode ? ` Padrão: ${spec.defaultMode}.` : "";
    const qualityPart = spec.qualities ? ' Qualidade opcional: "full"|"mid"|"low".' : "";
    lines.push(
      `${n}. ${spec.command}("url"${modesPart}) — ${spec.description} ${formatAliases(spec.aliases)}${defaultPart}${qualityPart}`
    );
    lines.push(`   Plataformas: ${spec.platforms}.`);
    if (spec.examples?.length) {
      lines.push(`   Ex.: ${spec.examples.join(" · ")}`);
    }
    n += 1;
  }
  return lines;
}

/** Regras gerais de download para o prompt da LLM. */
export function buildAgentDownloadRulesPromptLines() {
  return [
    "COMANDOS DE DOWNLOAD — REGRAS:",
    '- Sintaxe: comando("url_completa", "modo_opcional", "qualidade_opcional"). URL sempre entre aspas.',
    "- 1º arg = URL; 2º = modo (mp3, mp4, post, user, banner); 3º opcional = qualidade (full, mid, low).",
    "- Se o usuário mandou link no chat ou no quote, use esse link — **nunca** message id.",
    "- Escolha o comando pela plataforma (YouTube → youtube/yt, TikTok → tiktok/tk/ttok, etc.).",
    '- Rede sem comando dedicado → download("url") ou baixar("url").',
    "- TikTok: tiktok(), tk() ou ttok(). **tt é Twitter**, não TikTok.",
    '- thumbnail/thumb: só link do YouTube, sem modo nem qualidade.',
    "- Modos: mp3=áudio, mp4=vídeo, post=mídia do post, user=foto de perfil, banner=capa (só Twitter).",
    "- Se não especificarem modo: YouTube/TikTok → mp4; demais → post.",
    "- Quando pedirem baixar/mandar/pegar o link, use o comando — pode combinar com mensagem curta."
  ];
}

/** Exemplos de download para o prompt da LLM. */
export function buildAgentDownloadExampleLines() {
  return [
    "Exemplos de download:",
    'mensagem("pera vou baixar")',
    'youtube("https://youtu.be/abc123", "mp3")',
    'yt("https://youtu.be/abc123", "mp4", "mid")',
    'tiktok("https://www.tiktok.com/@user/video/123", "mp4")',
    'twitter("https://x.com/user/status/123", "post")',
    'download("https://vimeo.com/123456", "mp4")',
    'thumb("https://youtu.be/abc123")'
  ];
}

/** Bloco dinâmico quando há URL detectada na mensagem do usuário. */
export function buildUrlDownloadIntentPromptBlock(intent = null) {
  if (!intent?.url) return [];
  const spec = AGENT_URL_DOWNLOAD_PROMPT_SPECS.find((s) => s.command === intent.command);
  const modesHint = spec?.modes?.length
    ? ` Modos: ${spec.modes.join(", ")}${spec.defaultMode ? ` (padrão: ${spec.defaultMode})` : ""}.`
    : "";
  const qualityHint = spec?.qualities ? ' Qualidade: "full", "mid" ou "low".' : "";
  const argsSuffix = intent.args?.length
    ? `, "${intent.args.join('", "')}"`
    : spec?.defaultMode && spec.modes.length
      ? `, "${spec.defaultMode}"`
      : "";
  return [
    "[PEDIDO DE DOWNLOAD]",
    `URL detectada: ${intent.url}`,
    `Plataforma inferida: ${intent.command}. ${spec?.platforms ?? ""}${modesHint}${qualityHint}`,
    `Execute: ${intent.command}("${intent.url}"${argsSuffix})`,
    "NÃO responda só com mensagem() — use o comando de download adequado."
  ];
}
