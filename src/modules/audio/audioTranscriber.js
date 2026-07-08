import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __dirname = dirname(fileURLToPath(import.meta.url));
const WHISPER_WORKER = join(__dirname, "whisperWorker.py");

function normalizeTranscript(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function runFfmpegToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

async function convertToWavIfNeeded(filePath, mimetype = "") {
  if (/\.wav$/i.test(filePath)) return { path: filePath, disposable: null };
  const isOgg =
    /\.ogg$/i.test(filePath) ||
    String(mimetype ?? "").includes("ogg") ||
    String(mimetype ?? "").includes("opus");
  if (!isOgg && /\.(mp3|m4a|aac|flac)$/i.test(filePath)) {
    return { path: filePath, disposable: null };
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "tetos-audio-"));
  const out = join(tmpDir, "audio.wav");
  try {
    await runFfmpegToWav(filePath, out);
    if (!existsSync(out)) return { path: filePath, disposable: null };
    return { path: out, disposable: out };
  } catch {
    return { path: filePath, disposable: null };
  }
}

class WhisperWorkerPool {
  constructor({ pythonPath = "python", model = "small", language = "pt" } = {}) {
    this.pythonPath = pythonPath;
    this.model = model;
    this.language = language;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.pythonPath, [WHISPER_WORKER, this.model, this.language], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const resolver = this.pending.values().next().value;
        if (resolver) {
          const firstKey = this.pending.keys().next().value;
          this.pending.delete(firstKey);
          try {
            resolver(JSON.parse(line));
          } catch (error) {
            resolver({ error: error.message });
          }
        }
      }
    });
    this.proc.on("error", () => {
      this.proc = null;
    });
    this.proc.on("close", () => {
      this.proc = null;
      for (const [, reject] of this.pending) {
        reject({ error: "whisper worker exited" });
      }
      this.pending.clear();
    });
  }

  transcribe(filePath) {
    return new Promise((resolve) => {
      this.start();
      if (!this.proc?.stdin?.writable) {
        resolve({ error: "whisper worker unavailable" });
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${filePath}\n`);
    });
  }
}

let sharedPool = null;

function getPool(config) {
  const key = `${config.pythonPath}:${config.model}:${config.language}`;
  if (!sharedPool || sharedPool.key !== key) {
    sharedPool = { key, pool: new WhisperWorkerPool(config) };
  }
  return sharedPool.pool;
}

function buildFallbackTranscript({ filePath, mimetype, seconds }) {
  const size = readFileSync(filePath).byteLength;
  const hints = [];
  hints.push("Áudio recebido por WhatsApp.");
  hints.push(`Arquivo: ${filePath}`);
  hints.push(`Tipo: ${mimetype}`);
  if (seconds) hints.push(`Duração aproximada: ${seconds}s`);
  hints.push(`Tamanho: ${size} bytes`);
  hints.push(
    "Não foi possível transcrever automaticamente; trate como áudio recebido e peça confirmação breve se o conteúdo for necessário."
  );
  return normalizeTranscript(hints.join(" "));
}

export class AudioTranscriber {
  constructor({
    enabled = true,
    model = "small",
    language = "pt",
    pythonPath = "python"
  } = {}) {
    this.enabled = enabled !== false;
    this.model = model;
    this.language = language;
    this.pythonPath = pythonPath;
  }

  async transcribe({ filePath, mimetype = "audio/ogg", seconds = null } = {}) {
    if (!this.enabled || !filePath) return null;

    const { path: inputPath, disposable } = await convertToWavIfNeeded(filePath, mimetype);
    try {
      const pool = getPool({
        pythonPath: this.pythonPath,
        model: this.model,
        language: this.language
      });
      const result = await pool.transcribe(inputPath);
      const normalized = normalizeTranscript(result?.text ?? "");
      if (normalized && !result?.error) {
        return { text: normalized, source: "whisper" };
      }
    } catch {
      /* fallback below */
    } finally {
      if (disposable && existsSync(disposable)) {
        try {
          unlinkSync(disposable);
        } catch {
          /* ignore */
        }
      }
    }

    return {
      text: buildFallbackTranscript({ filePath, mimetype, seconds }),
      source: "fallback"
    };
  }
}
