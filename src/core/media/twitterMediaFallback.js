import { mkdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fetchUrlToFile } from "./ytDlpRunner.js";
import { applyTwitterImageQuality } from "./downloadQuality.js";

const VX_ENDPOINTS = (statusId) => [
  `https://api.vxtwitter.com/status/${statusId}`,
  `https://api.fxtwitter.com/status/${statusId}`
];

export function extractTwitterStatusId(url = "") {
  const m = String(url).match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i);
  return m?.[1] ?? null;
}

export function shouldUseTwitterMediaFallback(error, mode = "post") {
  if (mode === "mp3" || mode === "user" || mode === "banner") return false;
  const msg = String(error?.message ?? error).toLowerCase();
  return (
    msg.includes("no video could be found") ||
    msg.includes("no suitable formats") ||
    msg.includes("no formats found") ||
    msg.includes("no media could be found") ||
    msg.includes("nothing to download")
  );
}

function extFromUrl(url = "") {
  const clean = String(url).split("?")[0];
  const ext = extname(clean).replace(/^\./, "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm"].includes(ext)) {
    return ext === "jpeg" ? "jpg" : ext;
  }
  if (String(url).includes("video.twimg.com")) return "mp4";
  if (String(url).includes("pbs.twimg.com")) return "jpg";
  return "bin";
}

function mediaKindFromType(type = "", url = "") {
  const t = String(type).toLowerCase();
  if (t === "video" || t === "gif" || String(url).includes("video.twimg.com")) return "video";
  return "image";
}

function parseVxTwitterMedia(json, mode) {
  const extended = Array.isArray(json?.media_extended) ? json.media_extended : [];
  const urls = Array.isArray(json?.mediaURLs) ? json.mediaURLs : [];

  if (extended.length) {
    const mapped = extended.map((item, index) => {
      const url = item?.url || urls[index] || urls[0];
      if (!url) return null;
      return {
        url,
        type: mediaKindFromType(item?.type, url),
        ext: extFromUrl(url)
      };
    }).filter(Boolean);

    if (mode === "mp4") {
      return mapped.filter((item) => item.type === "video");
    }
    return mapped;
  }

  const fallback = urls.map((url) => ({
    url,
    type: mediaKindFromType("", url),
    ext: extFromUrl(url)
  }));
  if (mode === "mp4") return fallback.filter((item) => item.type === "video");
  return fallback;
}

function parseFxTwitterMedia(json, mode) {
  const tweet = json?.tweet ?? {};
  const media = tweet?.media ?? {};
  const items = [];

  for (const photo of media.photos ?? []) {
    if (!photo?.url) continue;
    items.push({
      url: photo.url,
      type: "image",
      ext: extFromUrl(photo.url)
    });
  }
  for (const video of media.videos ?? media.animated ?? []) {
    const url = video?.url ?? video?.variants?.[0]?.url;
    if (!url) continue;
    items.push({
      url,
      type: "video",
      ext: extFromUrl(url)
    });
  }

  if (mode === "mp4") return items.filter((item) => item.type === "video");
  return items;
}

function parseTweetMedia(json, mode) {
  if (json?.media_extended || json?.mediaURLs) {
    return parseVxTwitterMedia(json, mode);
  }
  return parseFxTwitterMedia(json, mode);
}

async function fetchTweetJson(statusId) {
  let lastError = null;
  for (const endpoint of VX_ENDPOINTS(statusId)) {
    try {
      const res = await fetch(endpoint, {
        headers: { "User-Agent": "TetOS/1.0", Accept: "application/json" },
        redirect: "follow"
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      if (json?.code && json.code !== 200) {
        lastError = new Error(json?.message ?? "fxtwitter error");
        continue;
      }
      return json;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error("nao consegui consultar midia do tweet");
}

export async function resolveTwitterMediaItems(url, mode = "post", quality = "full") {
  const statusId = extractTwitterStatusId(url);
  if (!statusId) throw new Error("link do twitter invalido");

  const json = await fetchTweetJson(statusId);
  const items = parseTweetMedia(json, mode).map((item) => {
    if (item.type !== "image") return item;
    return { ...item, url: applyTwitterImageQuality(item.url, quality) };
  });
  if (!items.length) {
    if (mode === "mp4") {
      throw new Error("esse tweet nao tem video — tenta sem mp4 ou use post");
    }
    throw new Error("tweet sem midia para baixar");
  }
  return { statusId, items };
}

export async function downloadTwitterMediaItems(items, outputDir, statusId) {
  mkdirSync(outputDir, { recursive: true });
  const downloaded = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const suffix = items.length > 1 ? `-${i + 1}` : "";
    const dest = join(outputDir, `dl-${statusId}${suffix}.${item.ext}`);
    await fetchUrlToFile(item.url, dest, { timeoutMs: 45000 });
    if (!statSync(dest).size) throw new Error("download gerou arquivo vazio ou invalido");
    downloaded.push({ path: dest, mediaType: item.type });
  }

  return downloaded;
}
