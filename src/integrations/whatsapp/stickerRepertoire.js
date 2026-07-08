import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { enrichMediaVision } from "../../modules/vision/mediaVisionEnrich.js";
import {
  deriveStickerKeyFromVision,
  extractDisplayName,
  extractVisionCaption,
  sanitizeVisionDescription,
  slugifyStickerKey
} from "./stickerVisionNaming.js";

const CATALOG_NAME = "catalog.json";

const BUILTIN_KEYS = new Set(["teto-linguinha", "teto-pao", "teto-saliente", "ack", "ok", "thumbs_up", "heart"]);

export { slugifyStickerKey };

function previewText(text, max = 120) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Logs do pipeline repertório → visão → nome (console + tetos.log). */
export function logRepertoireVision(runtime, step, data = {}) {
  const payload = { step, ...data, ts: new Date().toISOString() };
  console.log(`[repertorio:vision] ${step}`, JSON.stringify(payload));
  runtime?.logger?.log?.("repertoire.vision", payload);
}

function catalogPath(basePath) {
  return join(basePath, CATALOG_NAME);
}

export function loadStickerCatalog(basePath = "./data/stickers") {
  return readJson(catalogPath(basePath), { entries: [] });
}

export function listRepertoireKeys(basePath = "./data/stickers") {
  const catalog = loadStickerCatalog(basePath);
  const fromCatalog = (catalog.entries ?? []).map((e) => e.key).filter(Boolean);
  let fromDisk = [];
  try {
    fromDisk = readdirSync(basePath)
      .filter((name) => name.endsWith(".webp"))
      .map((name) => name.replace(/\.webp$/i, ""));
  } catch {
    fromDisk = [];
  }
  return [...new Set([...fromCatalog, ...fromDisk])].sort();
}

export function isKnownStickerKey(key, basePath = "./data/stickers") {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k) return false;
  if (BUILTIN_KEYS.has(k)) return true;
  if (k.startsWith("teto-")) return true;
  return existsSync(join(basePath, `${k}.webp`));
}

function ensureUniqueStickerKey(basePath, baseKey) {
  const slug = slugifyStickerKey(baseKey);
  if (!slug) return null;
  let candidate = slug;
  let n = 2;
  while (existsSync(join(basePath, `${candidate}.webp`)) && n < 100) {
    candidate = `${slug}-${n}`;
    n += 1;
  }
  return candidate;
}

function findVisionDescription({ visualAnalyses = null, messageId = null, mediaPath = null } = {}) {
  if (visualAnalyses?.data?.entries?.length) {
    const mid = String(messageId ?? "").trim();
    for (let i = visualAnalyses.data.entries.length - 1; i >= 0; i -= 1) {
      const row = visualAnalyses.data.entries[i];
      const path = String(row?.mediaPath ?? "");
      if (mid && path.includes(mid)) return row.description ?? null;
      if (mediaPath && path === mediaPath) return row.description ?? null;
    }
  }
  return null;
}

function findCatalogByMessageId(basePath, messageId) {
  const mid = String(messageId ?? "").trim();
  if (!mid) return null;
  const catalog = loadStickerCatalog(basePath);
  for (let i = (catalog.entries ?? []).length - 1; i >= 0; i -= 1) {
    if (String(catalog.entries[i]?.messageId ?? "") === mid) return catalog.entries[i];
  }
  return null;
}

export function findRepertoireEntryByMessageId(basePath, messageId) {
  return findCatalogByMessageId(basePath, messageId);
}

export function isBuiltinRepertoireKey(key) {
  const k = String(key ?? "").trim().toLowerCase();
  return Boolean(k && BUILTIN_KEYS.has(k));
}

/**
 * Remove figurinha do repertório (arquivo + catálogo).
 */
export function removeStickerFromRepertoire({
  basePath = "./data/stickers",
  messageId = null,
  key = null
} = {}) {
  const catalog = loadStickerCatalog(basePath);
  let entry = null;
  const slugKey = slugifyStickerKey(key);
  if (slugKey) {
    entry = (catalog.entries ?? []).find((e) => e.key === slugKey) ?? null;
  } else if (messageId) {
    entry = findCatalogByMessageId(basePath, messageId);
  }
  if (!entry?.key) {
    return { ok: false, reason: "not_found" };
  }
  if (isBuiltinRepertoireKey(entry.key)) {
    return { ok: false, reason: "builtin", key: entry.key };
  }

  const filePath = join(basePath, `${entry.key}.webp`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }

  catalog.entries = (catalog.entries ?? []).filter((e) => e.key !== entry.key);
  writeJson(catalogPath(basePath), catalog);

  return {
    ok: true,
    key: entry.key,
    displayName: entry.displayName ?? null,
    messageId: entry.messageId ?? null
  };
}

/**
 * Copia figurinha para data/stickers e registra no catálogo.
 * @returns {{ key: string, path: string, created: boolean }}
 */
export function saveStickerToRepertoire({
  sourcePath,
  basePath = "./data/stickers",
  key = null,
  messageId = null,
  savedFrom = null,
  label = null,
  visionDescription = null,
  displayName = null,
  autoNamed = false
} = {}) {
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error("arquivo da figurinha nao encontrado");
  }

  mkdirSync(basePath, { recursive: true });

  const existing = findCatalogByMessageId(basePath, messageId);
  let finalKey = slugifyStickerKey(key);
  if (!finalKey) {
    const mid = String(messageId ?? "")
      .replace(/[^0-9A-F]/gi, "")
      .slice(-8);
    finalKey = mid ? `rep-${mid.toLowerCase()}` : `rep-${Date.now()}`;
  } else if (!existing) {
    finalKey = ensureUniqueStickerKey(basePath, finalKey) ?? finalKey;
  } else if (existing?.key) {
    finalKey = existing.key;
  }

  const dest = join(basePath, `${finalKey}.webp`);
  const created = !existsSync(dest);
  copyFileSync(sourcePath, dest);

  const cleanedVision = sanitizeVisionDescription(visionDescription);
  const caption = extractVisionCaption(cleanedVision || visionDescription);
  const resolvedDisplayName =
    displayName ?? extractDisplayName(cleanedVision || visionDescription) ?? null;

  logRepertoireVision(null, "catalog_write", {
    messageId,
    key: finalKey,
    created,
    visionRaw: previewText(visionDescription),
    visionCleaned: previewText(cleanedVision),
    visionCaption: previewText(caption),
    displayName: resolvedDisplayName,
    autoNamed
  });

  const catalog = loadStickerCatalog(basePath);
  catalog.entries ??= [];
  const existingIdx = catalog.entries.findIndex((e) => e.key === finalKey);
  const entry = {
    key: finalKey,
    messageId: messageId ?? null,
    savedFrom: savedFrom ?? null,
    label: label ?? null,
    visionDescription: caption || null,
    displayName: resolvedDisplayName,
    autoNamed: Boolean(autoNamed),
    savedAt: new Date().toISOString()
  };
  if (existingIdx >= 0) {
    catalog.entries[existingIdx] = { ...catalog.entries[existingIdx], ...entry };
  } else {
    catalog.entries.push(entry);
  }
  if (catalog.entries.length > 200) {
    catalog.entries = catalog.entries.slice(-200);
  }
  writeJson(catalogPath(basePath), catalog);

  return { key: finalKey, path: dest, created, displayName: resolvedDisplayName, visionDescription: caption || visionDescription };
}

/**
 * Analisa figurinha com visão, nomeia e salva no repertório.
 * Se `key` vier preenchido, mantém a chave do usuário mas ainda grava o nome visual no catálogo.
 */
export async function saveStickerToRepertoireWithVision({
  runtime = null,
  sourcePath,
  basePath = "./data/stickers",
  key = null,
  messageId = null,
  savedFrom = null,
  label = null,
  media = null,
  userId = null,
  remoteJid = null,
  isForwarded = false,
  skipVision = false
} = {}) {
  logRepertoireVision(runtime, "save_with_vision_start", {
    messageId,
    sourcePath,
    userKey: key ?? null,
    skipVision,
    hasMediaTranscript: Boolean(media?.transcript),
    mediaTranscript: previewText(media?.transcript),
    isAnimated: Boolean(media?.isAnimated),
    isForwarded
  });

  const fromTranscript = sanitizeVisionDescription(media?.transcript);
  const fromVisualStore = sanitizeVisionDescription(
    findVisionDescription({
      visualAnalyses: runtime?.visualAnalyses,
      messageId,
      mediaPath: sourcePath
    })
  );

  let visionDescription = fromTranscript || fromVisualStore;
  let visionSource = fromTranscript ? "media.transcript" : fromVisualStore ? "visualAnalyses" : null;
  const userKey = slugifyStickerKey(key);

  logRepertoireVision(runtime, "vision_sources_checked", {
    messageId,
    fromTranscript: previewText(fromTranscript),
    fromVisualStore: previewText(fromVisualStore),
    visionAdapter: runtime?.defaults?.visionAdapter ?? null,
    ollamaVisionEnabled: runtime?.ollamaVisionAnalyzer?.isEnabled?.() ?? false,
    visionModel: runtime?.defaults?.visionModel || runtime?.defaults?.model || null
  });

  if (!visionDescription && runtime && !skipVision && !userKey) {
    logRepertoireVision(runtime, "vision_enrich_call", { messageId, sourcePath });
    visionDescription = await enrichMediaVision(runtime, {
      filePath: sourcePath,
      mediaType: "sticker",
      isAnimated: Boolean(media?.isAnimated)
    });
    visionSource = visionDescription ? "enrichMediaVision" : visionSource;
    logRepertoireVision(runtime, "vision_enrich_result", {
      messageId,
      ok: Boolean(visionDescription),
      raw: previewText(visionDescription)
    });
    if (visionDescription) {
      runtime.visualAnalyses?.save?.({
        userId: userId ?? "default",
        channelId: remoteJid ?? savedFrom ?? "default",
        mediaPath: sourcePath,
        mediaType: "sticker",
        description: visionDescription,
        source: "repertoire"
      });
    }
  } else if (!visionDescription && userKey) {
    logRepertoireVision(runtime, "vision_skipped", {
      messageId,
      reason: "user_key_provided"
    });
  } else if (!visionDescription) {
    logRepertoireVision(runtime, "vision_skipped", {
      messageId,
      reason: skipVision ? "skipVision" : !runtime ? "no_runtime" : "unknown"
    });
  }

  const sanitizedForNaming = sanitizeVisionDescription(visionDescription);
  let autoNamed = false;
  let resolvedKey = userKey;
  if (!resolvedKey) {
    resolvedKey = deriveStickerKeyFromVision(visionDescription, {
      messageId,
      prefix: isForwarded ? "fwd" : "rep"
    });
    autoNamed = true;
  }

  logRepertoireVision(runtime, "naming_resolved", {
    messageId,
    visionSource,
    visionRaw: previewText(visionDescription),
    visionSanitized: previewText(sanitizedForNaming),
    displayName: extractDisplayName(visionDescription),
    resolvedKey,
    autoNamed,
    userKeyProvided: Boolean(userKey)
  });

  const saved = saveStickerToRepertoire({
    sourcePath,
    basePath,
    key: resolvedKey,
    messageId,
    savedFrom,
    label,
    visionDescription,
    displayName: extractDisplayName(visionDescription),
    autoNamed
  });

  return { ...saved, autoNamed, forwarded: isForwarded, visionSource };
}

export function formatRepertoireForPrompt(basePath = "./data/stickers", limit = 24) {
  const catalog = loadStickerCatalog(basePath);
  const learned = (catalog.entries ?? []).filter((e) => e?.key && !BUILTIN_KEYS.has(e.key));
  if (!learned.length) {
    return "Repertório extra vazio — use salvarSticker(\"message_id\") (sem chave: o leitor de imagem nomeia) ou modoRepertorio(\"on\").";
  }
  const recent = learned.slice(-limit);
  const labels = recent.map((e) => {
    if (e.displayName) return `${e.key} ("${e.displayName}")`;
    if (e.visionDescription) return `${e.key} (${String(e.visionDescription).slice(0, 48)})`;
    return e.key;
  });
  const tail = learned.length > limit ? ` (+${learned.length - limit} mais)` : "";
  return `Figurinhas no repertório: ${labels.join(", ")}${tail}. Use sticker("chave") para enviar.`;
}

export function isForwardedMessage(contextInfo = {}) {
  if (!contextInfo) return false;
  if (contextInfo.isForwarded === true) return true;
  const score = Number(contextInfo.forwardingScore ?? 0);
  return Number.isFinite(score) && score > 0;
}

/** Salva figurinha automaticamente quando o modo repertório está ativo para o usuário. */
export async function tryAutoSaveIncomingSticker({
  runtime = null,
  repertoireModeStore = null,
  userId,
  remoteJid,
  messageId,
  media,
  isForwarded = false,
  pushName = null,
  basePath = "./data/stickers",
  skipVision = false
} = {}) {
  if (!repertoireModeStore?.isActive?.(userId)) {
    logRepertoireVision(runtime, "auto_save_skip", {
      messageId,
      userId,
      reason: "repertoire_mode_off"
    });
    return null;
  }
  if (media?.type !== "sticker" || !media?.path || !messageId) {
    logRepertoireVision(runtime, "auto_save_skip", {
      messageId,
      userId,
      reason: "not_sticker_or_missing_path",
      mediaType: media?.type ?? null,
      hasPath: Boolean(media?.path)
    });
    return null;
  }

  const label = isForwarded ? "encaminhada" : "recebida";

  logRepertoireVision(runtime, "auto_save_start", {
    messageId,
    userId,
    remoteJid,
    path: media.path,
    isForwarded,
    skipVision,
    transcript: previewText(media?.transcript)
  });

  try {
    const saved = await saveStickerToRepertoireWithVision({
      runtime,
      sourcePath: media.path,
      basePath,
      messageId,
      savedFrom: remoteJid,
      label: `${label}${pushName ? ` — ${pushName}` : ""}`,
      media,
      userId,
      remoteJid,
      isForwarded,
      skipVision
    });
    logRepertoireVision(runtime, "auto_save_ok", {
      messageId,
      key: saved.key,
      displayName: saved.displayName ?? null,
      visionSource: saved.visionSource ?? null,
      autoNamed: saved.autoNamed ?? false
    });
    return { ...saved, auto: true, forwarded: isForwarded };
  } catch (error) {
    logRepertoireVision(runtime, "auto_save_error", {
      messageId,
      userId,
      error: error?.message ?? String(error)
    });
    return null;
  }
}
