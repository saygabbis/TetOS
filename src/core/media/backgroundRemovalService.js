import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { normalizeRemoveBgModel, parseHexColor } from "./removeBgOptionsParse.js";
import { removeBgKeyPool } from "./removeBgKeyPool.js";

const REMOVE_BG_WORKER = join(dirname(fileURLToPath(import.meta.url)), "removeBgWorker.mjs");

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export const MAX_ANIMATED_FRAMES = 24;
export const MAX_ANIMATED_DURATION_SEC = 5;
/** Pipeline local (animado) — menos frames = mais rápido e menos queda de conexão WA. */
const MAX_ANIMATED_FRAMES_LOCAL = 12;
const MAX_ANIMATED_DURATION_SEC_LOCAL = 4;
const REMOVEBG_FRAME_VF =
  "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba";

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

function mimeFromPath(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

/** imgly só tem small|medium — forte (large) vira medium no fallback local. */
function resolveImglyModel(model = "small") {
  const m = normalizeRemoveBgModel(model) ?? "small";
  if (m === "large") return "medium";
  return m === "medium" ? "medium" : "small";
}

function removeBgWithImgly(inputPath, outputPath, model = "small") {
  const chain = [];
  const primary = resolveImglyModel(model);
  chain.push(primary);
  if (primary !== "small") chain.push("small");

  let lastDetail = "";
  for (const imglyModel of chain) {
    const r = spawnSync(process.execPath, [REMOVE_BG_WORKER, inputPath, outputPath, imglyModel], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000
    });
    if (r.status === 0 && existsSync(outputPath)) return;
    lastDetail = String(r.stderr || r.stdout || "").trim().slice(0, 200);
    if (!/not found|publicPath/i.test(lastDetail)) break;
  }
  throw new Error(lastDetail || "falha ao remover fundo (modelo local)");
}

function isRemoveBgApiUnavailable(status, errText = "") {
  const body = String(errText).toLowerCase();
  if (status === 402) return true;
  if (status === 429) return true;
  if (status === 401) return true;
  if (status === 403 && /credit|quota|limit|insufficient|exceeded|balance|invalid/.test(body)) {
    return true;
  }
  return false;
}

function normalizeRemoveBgKeys(removeBgApiKeys, removeBgApiKey) {
  if (Array.isArray(removeBgApiKeys) && removeBgApiKeys.length > 0) {
    return removeBgApiKeys.filter(Boolean);
  }
  const single = String(removeBgApiKey ?? "").trim();
  return single ? [single] : [];
}

async function removeBgWithRemoveBgApiOnce(inputPath, outputPath, apiKey, size = "auto") {
  const buf = readFileSync(inputPath);
  const mime = mimeFromPath(inputPath);
  const form = new FormData();
  form.append("image_file", new Blob([buf], { type: mime }), basename(inputPath));
  form.append("size", size);
  form.append("format", "png");

  const res = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": apiKey },
    body: form
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`remove.bg ${res.status}`);
    err.status = res.status;
    err.apiUnavailable = isRemoveBgApiUnavailable(res.status, errText);
    throw err;
  }
  writeFileSync(outputPath, Buffer.from(await res.arrayBuffer()));
}

/** forte pede full; contas free muitas vezes só aceitam auto — tenta os dois. */
async function removeBgWithRemoveBgApi(inputPath, outputPath, apiKey, size = "auto") {
  const sizes = size === "full" ? ["full", "auto"] : [size];
  let lastErr;
  for (const attemptSize of sizes) {
    try {
      await removeBgWithRemoveBgApiOnce(inputPath, outputPath, apiKey, attemptSize);
      return;
    } catch (err) {
      lastErr = err;
      if (err.apiUnavailable) throw err;
      if (attemptSize !== sizes[sizes.length - 1]) continue;
    }
  }
  throw lastErr;
}

function resolveRemoveBgPipeline(model = "small") {
  const m = normalizeRemoveBgModel(model) ?? "small";
  return {
    model: m,
    /** remove.bg: forte = full; media = auto; leve = só local imgly */
    apiSize: m === "large" ? "full" : "auto",
    useApi: m !== "small"
  };
}

/**
 * Remove fundo de imagem estática → PNG com alpha.
 * Tenta cada chave remove.bg em sequência; só usa imgly local quando todas esgotam.
 * @returns {{ usedApi: boolean, apiExhausted?: boolean }}
 */
export async function removeImageBackground(
  inputPath,
  outputPath,
  { removeBgApiKeys, removeBgApiKey, model = "small", localOnly = false } = {}
) {
  const pipeline = resolveRemoveBgPipeline(model);
  const keys = normalizeRemoveBgKeys(removeBgApiKeys, removeBgApiKey);

  if (localOnly) {
    removeBgWithImgly(inputPath, outputPath, pipeline.model);
    return { usedApi: false, localOnly: true };
  }

  if (keys.length > 0 && pipeline.useApi) {
    const attempted = new Set();
    while (attempted.size < keys.length) {
      const apiKey = await removeBgKeyPool.pickKey(keys);
      if (!apiKey || attempted.has(apiKey)) break;
      attempted.add(apiKey);
      try {
        await removeBgWithRemoveBgApi(inputPath, outputPath, apiKey, pipeline.apiSize);
        removeBgKeyPool.noteSuccess(apiKey);
        return { usedApi: true };
      } catch (err) {
        if (err.apiUnavailable) {
          removeBgKeyPool.markExhausted(apiKey, `HTTP ${err.status ?? "?"}`);
          continue;
        }
        if (!err.status || err.status >= 500) {
          if (process.env.TETOS_REMOVEBG_DEBUG) {
            console.warn("[removebg] erro API transiente, proxima chave:", err?.message ?? err);
          }
          continue;
        }
        if (process.env.TETOS_REMOVEBG_DEBUG) {
          console.warn("[removebg] erro API (nao-quota), modelo local:", err?.message ?? err);
        }
        break;
      }
    }
    if (process.env.TETOS_REMOVEBG_DEBUG && !removeBgKeyPool.hasAvailableKey(keys)) {
      console.warn("[removebg] todas as chaves esgotadas — usando modelo local");
    }
    removeBgWithImgly(inputPath, outputPath, pipeline.model);
    return { usedApi: false, apiExhausted: !removeBgKeyPool.hasAvailableKey(keys) };
  }

  removeBgWithImgly(inputPath, outputPath, pipeline.model);
  return { usedApi: false };
}

/**
 * Aplica cor sólida atrás do recorte ou mantém transparência.
 */
export async function applyBackgroundToPng(transparentPngPath, outputPath, backgroundHex) {
  if (!backgroundHex) {
    writeFileSync(outputPath, readFileSync(transparentPngPath));
    return;
  }
  const { r, g, b } = parseHexColor(backgroundHex);
  const hex =
    `${r.toString(16).padStart(2, "0")}` +
    `${g.toString(16).padStart(2, "0")}` +
    `${b.toString(16).padStart(2, "0")}`;
  await runFfmpeg(
    ffmpeg()
      .input(transparentPngPath)
      .input(`color=c=0x${hex}`)
      .inputOptions(["-f", "lavfi"])
      .complexFilter(["[1][0]scale2ref[bg][fg]", "[bg][fg]overlay=shortest=1[out]"])
      .outputOptions(["-map", "[out]"])
      .save(outputPath)
  );
}

function probeFps(inputPath) {
  try {
    const exe = ffmpegInstaller.path;
    const r = spawnSync(exe, ["-nostdin", "-hide_banner", "-i", inputPath], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });
    const stream = /Video:.*,\s*([\d.]+)\s*fps/i.exec(String(r.stderr || ""));
    if (stream) {
      const fps = Number(stream[1]);
      if (Number.isFinite(fps) && fps > 0 && fps <= 30) return fps;
    }
    const avg = /(\d+(?:\.\d+)?)\s*fps/i.exec(String(r.stderr || ""));
    if (avg) {
      const fps = Number(avg[1]);
      if (Number.isFinite(fps) && fps > 0 && fps <= 30) return fps;
    }
  } catch {
    /* default */
  }
  return 10;
}

async function extractFrames(inputPath, framesDir, { maxFrames, maxSec } = {}) {
  const frameLimit = maxFrames ?? MAX_ANIMATED_FRAMES;
  const secLimit = maxSec ?? MAX_ANIMATED_DURATION_SEC;
  mkdirSync(framesDir, { recursive: true });
  const pattern = join(framesDir, "frame_%04d.png");
  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions([
        "-an",
        "-t",
        String(secLimit),
        "-frames:v",
        String(frameLimit),
        "-vsync",
        "0"
      ])
      .output(pattern)
  );
  const frames = readdirSync(framesDir)
    .filter((f) => /^frame_\d+\.png$/i.test(f))
    .sort();
  if (frames.length === 0) {
    throw new Error("nao foi possivel extrair frames do GIF/video");
  }
  return { frames, fps: Math.min(probeFps(inputPath), 15) };
}

async function normalizeRemoveBgFrame(inputPath, outputPath) {
  await runFfmpeg(
    ffmpeg(inputPath)
      .outputOptions(["-frames:v", "1", "-update", "1", "-vf", REMOVEBG_FRAME_VF])
      .save(outputPath)
  );
}

async function reassembleTransparentGif(framesDir, frames, outputPath, fps) {
  const inputPattern = join(framesDir, "frame_%04d.png");
  const palettePath = join(framesDir, "_palette.png");
  const vfChain =
    `${REMOVEBG_FRAME_VF},split[s0][s1];[s0]palettegen=reserve_transparent=1:stats_mode=full[p];[s1][p]paletteuse=alpha`;

  try {
    await runFfmpeg(
      ffmpeg()
        .input(inputPattern)
        .inputOptions(["-framerate", String(fps)])
        .outputOptions(["-an", "-vf", vfChain, "-loop", "0"])
        .save(outputPath)
    );
    return;
  } catch {
    /* fallback 2-pass abaixo */
  }

  await runFfmpeg(
    ffmpeg()
      .input(inputPattern)
      .inputOptions(["-framerate", String(fps)])
      .outputOptions([
        "-frames:v",
        "1",
        "-vf",
        `${REMOVEBG_FRAME_VF},palettegen=reserve_transparent=1:stats_mode=full`
      ])
      .save(palettePath)
  );
  await runFfmpeg(
    ffmpeg()
      .input(inputPattern)
      .inputOptions(["-framerate", String(fps)])
      .input(palettePath)
      .complexFilter([
        `[0:v]${REMOVEBG_FRAME_VF}[fg]`,
        "[fg][1:v]paletteuse=alpha[out]"
      ])
      .outputOptions(["-an", "-map", "[out]", "-loop", "0"])
      .save(outputPath)
  );
}

async function reassembleColoredMp4(framesDir, _frames, outputPath, fps) {
  const inputPattern = join(framesDir, "frame_%04d.png");
  await runFfmpeg(
    ffmpeg()
      .input(inputPattern)
      .inputOptions(["-framerate", String(fps)])
      .videoCodec("libx264")
      .outputOptions([
        "-an",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos",
        "-profile:v",
        "baseline",
        "-level",
        "3.1"
      ])
      .save(outputPath)
  );
}

/**
 * Remove fundo frame a frame (GIF/vídeo curto).
 */
/** GIF/vídeo/figurinha animada — só imgly local (não gasta créditos remove.bg). */
export async function removeAnimatedBackground(
  inputPath,
  outputDir,
  { background, model = "small" } = {}
) {
  const tmpDir = mkdtempSync(join(tmpdir(), "tetos-removebg-"));
  const framesDir = join(tmpDir, "frames");
  const processedDir = join(tmpDir, "processed");
  mkdirSync(processedDir, { recursive: true });

  try {
    const { frames, fps } = await extractFrames(inputPath, framesDir, {
      maxFrames: MAX_ANIMATED_FRAMES_LOCAL,
      maxSec: MAX_ANIMATED_DURATION_SEC_LOCAL
    });

    for (const frame of frames) {
      const src = join(framesDir, frame);
      const nobg = join(processedDir, frame);
      const normalized = join(processedDir, `norm-${frame}`);
      const final = join(framesDir, frame);
      await removeImageBackground(src, nobg, { model, localOnly: true });
      if (background) {
        const colored = join(processedDir, `color-${frame}`);
        await applyBackgroundToPng(nobg, colored, background);
        await normalizeRemoveBgFrame(colored, final);
      } else {
        await normalizeRemoveBgFrame(nobg, final);
      }
    }

    const base = basename(inputPath, extname(inputPath));
    if (background) {
      const outMp4 = join(outputDir, `${base}-removebg.mp4`);
      await reassembleColoredMp4(framesDir, frames, outMp4, fps);
      return {
        kind: "video",
        path: outMp4,
        mimetype: "video/mp4",
        fileName: "sem-fundo.mp4"
      };
    }

    const outGif = join(outputDir, `${base}-removebg.gif`);
    await reassembleTransparentGif(framesDir, frames, outGif, fps);
    return {
      kind: "video",
      path: outGif,
      mimetype: "image/gif",
      fileName: "sem-fundo.gif"
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function isAnimatedMedia(inputPath) {
  if (!existsSync(inputPath)) return false;
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".gif") return true;
  if (ext === ".mp4" || ext === ".webm" || ext === ".mov" || ext === ".mkv") return true;
  try {
    const head = readFileSync(inputPath, { start: 0, end: 5 });
    if (head.toString("ascii").startsWith("GIF")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export async function isAnimatedImage(inputPath) {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".gif") return true;
  try {
    const head = readFileSync(inputPath);
    if (head.length >= 6) {
      const sig = head.toString("ascii", 0, 6);
      if (sig.startsWith("GIF87") || sig.startsWith("GIF89")) return true;
    }
    if (
      head.length >= 12 &&
      head.toString("ascii", 0, 4) === "RIFF" &&
      head.toString("ascii", 8, 12) === "WEBP"
    ) {
      return head.includes(Buffer.from("ANIM"));
    }
  } catch {
    return false;
  }
  return false;
}
