export const DOWNLOAD_QUALITIES = Object.freeze(["full", "mid", "low"]);

const QUALITY_ALIASES = Object.freeze({
  full: "full",
  alta: "full",
  alto: "full",
  max: "full",
  mid: "mid",
  medio: "mid",
  media: "mid",
  meio: "mid",
  low: "low",
  baixa: "low",
  baixo: "low",
  min: "low"
});

export function normalizeDownloadQuality(value, { defaultQuality = "full" } = {}) {
  const token = String(value ?? "").trim().toLowerCase();
  if (!token) return defaultQuality;
  return QUALITY_ALIASES[token] ?? null;
}

/** Seletor yt-dlp para vídeo por nível de qualidade. */
export function videoFormatSelector(quality = "full") {
  const q = normalizeDownloadQuality(quality) ?? "full";
  if (q === "low") {
    return "worstvideo[ext=mp4]+worstaudio[ext=m4a]/worstvideo+worstaudio/worst[ext=mp4]/worst";
  }
  if (q === "mid") {
    return "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720][ext=mp4]/best[height<=720]/best";
  }
  return "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best";
}

/** 0 = melhor, 9 = pior (VBR do ffmpeg no yt-dlp). */
export function audioQualityValue(quality = "full") {
  const q = normalizeDownloadQuality(quality) ?? "full";
  if (q === "low") return "9";
  if (q === "mid") return "5";
  return "0";
}

/** Ajusta URL de imagem do Twitter (pbs.twimg.com) para resolução desejada. */
export function applyTwitterImageQuality(url, quality = "full") {
  const u = String(url ?? "");
  if (!u.includes("pbs.twimg.com")) return u;
  const q = normalizeDownloadQuality(quality) ?? "full";
  const name = q === "low" ? "small" : q === "mid" ? "large" : "orig";
  const base = u.split("?")[0];
  return `${base}?format=jpg&name=${name}`;
}
