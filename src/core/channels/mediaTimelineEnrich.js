import { join } from "node:path";
import { readJson } from "../../infra/utils/fileStore.js";

const MEDIA_PLACEHOLDER_RE = /^\[(sticker|image|video|gif|audio|media|figurinha|imagem)\]$/i;

function extractMessageIdFromMediaPath(mediaPath = "") {
  const m = String(mediaPath).match(/([0-9A-F]{10,})-(?:image|video|sticker|audio|document)/i);
  return m?.[1]?.toUpperCase() ?? null;
}

function loadCatalogVision(stickersPath) {
  if (!stickersPath) return [];
  try {
    return readJson(join(stickersPath, "catalog.json"), { entries: [] }).entries ?? [];
  } catch {
    return [];
  }
}

/**
 * Mapa messageId → { text, mediaType } a partir de multimodal, visualAnalyses e catálogo.
 */
export function buildVisionByMessageId(runtime, channelId, { stickersPath = null } = {}) {
  const map = new Map();
  const cid = String(channelId ?? "");
  const catalogPath = stickersPath ?? runtime?.defaults?.stickersPath ?? null;

  for (const row of runtime?.multimodalMemory?.data?.entries ?? []) {
    if (String(row.channelId ?? "") !== cid || !row.messageId) continue;
    const text = String(row.text ?? "").trim();
    if (!text) continue;
    map.set(String(row.messageId), { text, mediaType: row.mediaType ?? "media" });
  }

  for (const row of runtime?.visualAnalyses?.data?.entries ?? []) {
    if (String(row.channelId ?? "") !== cid) continue;
    const description = String(row.description ?? "").trim();
    if (!description) continue;
    const mid = extractMessageIdFromMediaPath(String(row.mediaPath ?? ""));
    if (!mid || map.has(mid)) continue;
    map.set(mid, { text: description, mediaType: row.mediaType ?? "image" });
  }

  for (const row of loadCatalogVision(catalogPath)) {
    const mid = String(row.messageId ?? "").trim();
    const desc = String(row.visionDescription ?? row.displayName ?? "").trim();
    if (!mid || !desc || map.has(mid)) continue;
    map.set(mid, { text: desc, mediaType: "sticker" });
  }

  return map;
}

export function isMediaPlaceholderText(text = "") {
  const s = String(text ?? "").trim();
  return !s || MEDIA_PLACEHOLDER_RE.test(s);
}

/** Substitui [sticker]/[image] por descrição visual quando disponível. */
export function enrichTimelineEntryText(entry = {}, visionByMessageId = null) {
  const raw = String(entry.text ?? entry.content ?? "").trim();
  const msgId = String(entry.messageId ?? entry.id ?? "").trim();
  if (!msgId || !visionByMessageId?.get) return raw;

  const vision = visionByMessageId.get(msgId);
  if (!vision?.text) return raw;

  const kind = vision.mediaType ?? "mídia";
  const label = kind === "sticker" ? "figurinha" : kind;

  if (isMediaPlaceholderText(raw)) {
    return `[${label}] ${vision.text}`;
  }

  if (!raw.toLowerCase().includes(vision.text.slice(0, 24).toLowerCase())) {
    return `${raw} [visão da ${label}: ${vision.text}]`;
  }

  return raw;
}

export function formatMediaInputText({ text = "", media = null } = {}) {
  const caption = String(text ?? "").trim();
  const rawVision = String(media?.transcript ?? media?.caption ?? "").trim();
  const kind = media?.type ?? "mídia";
  const vision =
    media?.type === "audio" && rawVision
      ? media?.transcriptSource === "whisper"
        ? `[áudio transcrito: ${rawVision}]`
        : rawVision.startsWith("[áudio transcrito:")
          ? rawVision
          : `[áudio: ${rawVision}]`
      : rawVision;

  if (caption && vision && !caption.includes(vision.slice(0, 20))) {
    return `${caption} ${vision}`;
  }
  if (vision) return vision;
  if (caption) return caption;
  return `[${kind}]`;
}
