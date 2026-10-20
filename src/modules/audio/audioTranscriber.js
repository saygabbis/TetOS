import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

/**
 * Transcrição dos áudios do WhatsApp. Backends, nesta ordem:
 *  - "api": endpoint compatível com OpenAI (/audio/transcriptions) — ex.: Groq whisper-large-v3-turbo (grátis);
 *    só se TETOS_STT_API_KEY estiver definido.
 *  - "local": Whisper em Node (transformers.js) num processo filho; baixa o modelo na 1ª vez.
 * Sem transcrição → { text: null, source: "unavailable" }: a Teto diz que não conseguiu ouvir, sem inventar.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = join(__dirname, "whisperProcess.js");
const JOB_TIMEOUT_MS = 150_000;
const WARMUP_TIMEOUT_MS = 15 * 60_000;
const IDLE_KILL_MS = 15 * 60_000;

const LANGUAGE_NAMES = { pt: "portuguese", en: "english", es: "spanish", ja: "japanese", fr: "french", it: "italian", de: "german" };
const LEGACY_MODELS = { tiny: "whisper-tiny", base: "whisper-base", small: "whisper-small", medium: "whisper-medium" };

/** Frases que o Whisper "ouve" em silêncio/música (vêm de legendas de vídeo do treino). */
const HALLUCINATIONS = [
  /legendas? (pela|por) .*amara/i,
  /^(obrigad[oa] por assistir|inscreva-se no canal|deixe seu like|tchau,? tchau)[.!]*$/i,
  /^(\[?m[uú]sica\]?|♪+|\.+)$/i,
  /^(sous-titres|subtitles by|transcribed by)/i
];

export function resolveWhisperModelId(model = "small") {
  const m = String(model ?? "").trim() || "small";
  if (m.includes("/")) return m;
  return `onnx-community/${LEGACY_MODELS[m] ?? m}`;
}

/** Limpa a saída do Whisper; string vazia = não tinha fala de verdade. */
export function cleanTranscript(raw = "") {
  let text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // "kkkkkkkk…" e "ooooooo…" sem fim: corta a repetição.
  text = text.replace(/(\p{L})\1{7,}/gu, "$1$1$1$1");
  text = text.replace(/\b(\p{L}[\p{L}'-]*)(?:[\s,]+\1\b){3,}/giu, "$1 $1");
  if (HALLUCINATIONS.some((re) => re.test(text))) return "";
  // "Ooooo", "Hmmmm": tom/ruído, não fala.
  const letters = text.toLowerCase().replace(/[^\p{L}]/gu, "");
  if (new Set(letters).size === 1 || /^h+m+$/.test(letters)) return "";
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return text;
}

class WhisperWorker {
  constructor({ modelId, language, modelsDir }) {
    this.env = {
      ...process.env,
      TETOS_WHISPER_MODEL_ID: modelId,
      TETOS_WHISPER_LANGUAGE_NAME: language,
      TETOS_MODELS_DIR: modelsDir,
      TETOS_FFMPEG_PATH: process.env.TETOS_FFMPEG_PATH || ffmpegInstaller.path
    };
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
  }

  ensure() {
    if (this.child) return this.child;
    // execArgv vazio: o filho não herda --import/--inspect do processo principal.
    const child = fork(WORKER, [], { env: this.env, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr?.on("data", (c) => {
      const line = String(c).trim();
      if (line && !/onnxruntime|W:onnx|CleanUnusedInitializers/i.test(line)) console.warn(`[whisper] ${line.slice(0, 300)}`);
    });
    child.on("message", (msg) => {
      const job = this.pending.get(msg?.id);
      if (!job) return;
      this.pending.delete(msg.id);
      clearTimeout(job.timer);
      job.resolve(msg);
      this.armIdle();
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      for (const [, job] of this.pending) {
        clearTimeout(job.timer);
        job.resolve({ error: "processo do whisper saiu" });
      }
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    if (this.pending.size) return;
    // Sem áudio por um tempo: libera a RAM do modelo (volta em ~3s quando precisar).
    this.idleTimer = setTimeout(() => this.stop(), IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  request(payload, timeoutMs = JOB_TIMEOUT_MS) {
    clearTimeout(this.idleTimer);
    return new Promise((resolvePromise) => {
      const child = this.ensure();
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolvePromise({ error: "whisper demorou demais" });
        this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, timer });
      child.send({ id, ...payload });
    });
  }

  stop() {
    clearTimeout(this.idleTimer);
    this.child?.kill();
    this.child = null;
  }
}

async function transcribeViaApi({ filePath, mimetype, url, key, model, language }) {
  const form = new FormData();
  const bytes = await readFile(filePath);
  form.append("file", new Blob([bytes], { type: mimetype || "audio/ogg" }), basename(filePath).replace(/\.\w+$/, "") + ".ogg");
  form.append("model", model);
  form.append("language", language);
  form.append("response_format", "json");
  form.append("temperature", "0");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`STT API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return String(json?.text ?? "");
}

export class AudioTranscriber {
  constructor({
    enabled = true,
    backend = process.env.TETOS_STT_BACKEND ?? "auto",
    model = "small",
    language = "pt",
    modelsDir = "./data/models",
    maxSeconds = Number(process.env.TETOS_STT_MAX_SECONDS ?? 300),
    api = {
      url: process.env.TETOS_STT_API_URL ?? "https://api.groq.com/openai/v1/audio/transcriptions",
      key: process.env.TETOS_STT_API_KEY ?? "",
      model: process.env.TETOS_STT_API_MODEL ?? "whisper-large-v3-turbo"
    }
  } = {}) {
    this.enabled = enabled !== false && backend !== "off";
    this.backend = backend;
    this.language = String(language || "pt").slice(0, 2).toLowerCase();
    this.maxSeconds = Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : 300;
    this.api = api;
    this.local = new WhisperWorker({
      modelId: resolveWhisperModelId(model),
      language: LANGUAGE_NAMES[this.language] ?? this.language,
      modelsDir: resolve(modelsDir)
    });
    this.queue = Promise.resolve();
  }

  get useApi() {
    return Boolean(this.api?.key) && (this.backend === "auto" || this.backend === "api");
  }

  get useLocal() {
    return this.backend === "auto" || this.backend === "local";
  }

  /** Baixa/carrega o modelo local em segundo plano para o 1º áudio não esperar o download. */
  warmup() {
    if (!this.enabled || !this.useLocal || this.useApi) return Promise.resolve(false);
    return this.local
      .request({ warmup: true }, WARMUP_TIMEOUT_MS)
      .then((r) => {
        if (r?.error) console.warn(`[whisper] aquecimento falhou: ${r.error}`);
        else console.log("[whisper] modelo local pronto");
        return !r?.error;
      });
  }

  async transcribe({ filePath, mimetype = "audio/ogg" } = {}) {
    if (!this.enabled || !filePath) return null;
    // Um áudio por vez: o modelo local usa todos os núcleos.
    const run = this.queue.then(() => this.transcribeNow({ filePath, mimetype }));
    this.queue = run.catch(() => {});
    return run;
  }

  async transcribeNow({ filePath, mimetype }) {
    if (this.useApi) {
      try {
        const text = cleanTranscript(await transcribeViaApi({ filePath, mimetype, ...this.api, language: this.language }));
        return text ? { text, source: "whisper-api" } : { text: null, source: "no_speech" };
      } catch (error) {
        console.warn(`[stt] API falhou, tentando local: ${error?.message ?? error}`);
      }
    }
    if (this.useLocal) {
      const r = await this.local.request({ file: resolve(filePath), maxSeconds: this.maxSeconds });
      if (!r?.error) {
        const text = cleanTranscript(r.text);
        return text ? { text, source: "whisper-local" } : { text: null, source: "no_speech" };
      }
      console.warn(`[whisper] transcrição falhou: ${r.error}`);
    }
    return { text: null, source: "unavailable" };
  }

  stop() {
    this.local.stop();
  }
}
