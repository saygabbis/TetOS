import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync
} from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readJson, writeJson } from "../utils/fileStore.js";

function resolveProjectPath(p) {
  if (!p) return "";
  const raw = String(p).trim();
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(process.cwd(), raw);
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function listFilesRecursive(dir, skipDirNames) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipDirNames.has(ent.name)) continue;
      out.push(...listFilesRecursive(p, skipDirNames));
    } else {
      try {
        const st = statSync(p);
        out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* ignorado */
      }
    }
  }
  return out;
}

function isImagePath(filePath) {
  return /\.(jpe?g|png|gif|webp)$/i.test(filePath);
}

function collectLearningMediaPaths(visualPath, multimodalPath) {
  const set = new Set();
  const vis = readJson(visualPath, { entries: [] });
  for (const e of vis.entries ?? []) {
    if (e?.mediaPath) set.add(path.normalize(resolveProjectPath(e.mediaPath)));
  }
  const mm = readJson(multimodalPath, { entries: [] });
  for (const e of mm.entries ?? []) {
    if (e?.mediaPath) set.add(path.normalize(resolveProjectPath(e.mediaPath)));
  }
  return set;
}

function rewriteLearningPaths(visualPath, multimodalPath, oldAbs, newAbs) {
  const oldN = path.normalize(oldAbs);
  const newRel = path.relative(process.cwd(), newAbs).replace(/\\/g, "/");
  const newStored = newRel.startsWith(".") ? newRel : `./${newRel}`;

  const patch = (data) => {
    let changed = false;
    for (const e of data.entries ?? []) {
      if (!e?.mediaPath) continue;
      const r = path.normalize(resolveProjectPath(e.mediaPath));
      if (r === oldN) {
        e.mediaPath = newStored;
        changed = true;
      }
    }
    return changed;
  };

  const v = readJson(visualPath, { entries: [] });
  v.entries ??= [];
  if (patch(v)) writeJson(visualPath, v);

  const m = readJson(multimodalPath, { entries: [] });
  m.entries ??= [];
  if (patch(m)) writeJson(multimodalPath, m);
}

async function archiveKnowledgeThumb(srcPath, archiveKnowledgeDir) {
  ensureDir(archiveKnowledgeDir);
  const key = createHash("sha1").update(srcPath).digest("hex").slice(0, 20);
  const dest = path.join(archiveKnowledgeDir, `${key}.jpg`);
  if (existsSync(dest)) return dest;
  try {
    await sharp(srcPath, { animated: true, pages: 1 })
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 74, mozjpeg: true })
      .toFile(dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Mantém `data/media` (exceto `_archive`) abaixo do teto: remove LRU.
 * Pasta `derived/` = só figurinha → apaga direto.
 * Ficheiros referenciados em vision/multimodal → miniatura JPG em `_archive/knowledge` e atualiza JSON.
 */
export async function runMediaRetentionSweep({
  mediaRoot,
  maxBytes,
  visualAnalysesPath,
  multimodalMemoryPath,
  logger
}) {
  const rootAbs = resolveProjectPath(mediaRoot);
  const archiveKnowledgeDir = path.join(rootAbs, "_archive", "knowledge");
  const skipDirs = new Set(["_archive"]);

  const files = listFilesRecursive(rootAbs, skipDirs);
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total <= maxBytes) return { prunedBytes: 0, deleted: 0, archived: 0 };

  const derivedMarker = `${path.sep}derived${path.sep}`;
  const learningPaths = collectLearningMediaPaths(visualAnalysesPath, multimodalMemoryPath);

  const derivedFiles = [];
  const otherFiles = [];
  for (const f of files) {
    const norm = path.normalize(f.path);
    if (norm.includes(derivedMarker)) {
      derivedFiles.push(f);
    } else {
      otherFiles.push(f);
    }
  }
  derivedFiles.sort((a, b) => a.mtime - b.mtime);
  otherFiles.sort((a, b) => a.mtime - b.mtime);
  const ordered = [...derivedFiles, ...otherFiles];

  let prunedBytes = 0;
  let deleted = 0;
  let archived = 0;

  for (const f of ordered) {
    if (total <= maxBytes) break;
    const pathNorm = path.normalize(f.path);
    const inDerived = pathNorm.includes(derivedMarker);

    try {
      if (!inDerived && isImagePath(f.path) && learningPaths.has(pathNorm)) {
        const dest = await archiveKnowledgeThumb(f.path, archiveKnowledgeDir);
        if (dest) {
          rewriteLearningPaths(visualAnalysesPath, multimodalMemoryPath, pathNorm, dest);
          archived += 1;
        } else {
          continue;
        }
      }

      unlinkSync(f.path);
      total -= f.size;
      prunedBytes += f.size;
      deleted += 1;
      learningPaths.delete(pathNorm);
    } catch (err) {
      logger?.log?.("media.retention_error", { path: f.path, error: String(err?.message ?? err) });
    }
  }

  if (prunedBytes > 0) {
    logger?.log?.("media.retention_sweep", {
      prunedBytes,
      deleted,
      archived,
      maxBytes
    });
  }

  return { prunedBytes, deleted, archived };
}
