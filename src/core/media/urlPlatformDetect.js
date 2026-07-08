/** Detecção de plataforma por URL para comandos de download. */

export const PLATFORMS = Object.freeze([
  "youtube",
  "twitter",
  "instagram",
  "reddit",
  "tiktok",
  "facebook",
  "generic"
]);

const COMMAND_TO_PLATFORM = Object.freeze({
  youtube: "youtube",
  yt: "youtube",
  twitter: "twitter",
  x: "twitter",
  tt: "twitter",
  instagram: "instagram",
  insta: "instagram",
  reddit: "reddit",
  rd: "reddit",
  tiktok: "tiktok",
  tk: "tiktok",
  ttok: "tiktok",
  facebook: "facebook",
  fb: "facebook",
  download: "generic",
  dl: "generic",
  baixar: "generic",
  thumbnail: "youtube",
  thumb: "youtube"
});

export function normalizeDownloadCommand(cmd) {
  return COMMAND_TO_PLATFORM[String(cmd ?? "").toLowerCase()] ?? String(cmd ?? "").toLowerCase();
}

export function isUrlDownloadCommand(cmd) {
  const key = String(cmd ?? "").toLowerCase();
  return key in COMMAND_TO_PLATFORM || PLATFORMS.includes(key);
}

export function detectPlatform(url = "") {
  const u = String(url ?? "").toLowerCase();
  if (!u) return "generic";
  if (/youtu\.be|youtube\.com|music\.youtube\.com/.test(u)) return "youtube";
  if (/reddit\.com|redd\.it|v\.redd\.it/.test(u)) return "reddit";
  if (/twitter\.com|x\.com|t\.co\//.test(u)) return "twitter";
  if (/instagram\.com|instagr\.am/.test(u)) return "instagram";
  if (/tiktok\.com|vm\.tiktok\.com/.test(u)) return "tiktok";
  if (/facebook\.com|fb\.watch|fb\.com/.test(u)) return "facebook";
  return "generic";
}

export function assertPlatformMatchesCommand(url, command) {
  const cmd = String(command ?? "").toLowerCase();
  if (["download", "dl", "baixar"].includes(cmd)) return null;
  const expected = COMMAND_TO_PLATFORM[cmd] ?? cmd;
  if (expected === "generic" || expected === "thumbnail") return null;
  const detected = detectPlatform(url);
  if (detected === "generic") return null;
  if (expected === "youtube" && (cmd === "thumbnail" || cmd === "thumb")) {
    if (detected !== "youtube") {
      return "O comando thumbnail/thumb so funciona com links do YouTube.";
    }
    return null;
  }
  if (expected !== detected) {
    const labels = {
      youtube: "YouTube",
      twitter: "X/Twitter",
      instagram: "Instagram",
      reddit: "Reddit",
      tiktok: "TikTok",
      facebook: "Facebook"
    };
    return `Esse link parece ser de ${labels[detected] ?? detected}, mas o comando e para ${labels[expected] ?? expected}.`;
  }
  return null;
}

export function extractYouTubeVideoId(url = "") {
  const u = String(url ?? "");
  const short = u.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  if (short) return short[1];
  const watch = u.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
  if (watch) return watch[1];
  const shorts = u.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{6,})/);
  if (shorts) return shorts[1];
  return null;
}
