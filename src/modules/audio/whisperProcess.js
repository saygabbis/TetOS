/**
 * Processo filho do Whisper local (transformers.js + onnxruntime). Roda separado para a inferência
 * não travar o event loop do WhatsApp e para o runtime nativo não conflitar com o do remove.bg.
 *
 * Protocolo (IPC): recebe { id, file, maxSeconds } ou { id, warmup: true }; responde { id, text?, error?, noSpeech?, seconds? }.
 */
import { spawn } from "node:child_process";

const MODEL = process.env.TETOS_WHISPER_MODEL_ID || "onnx-community/whisper-small";
const LANGUAGE = process.env.TETOS_WHISPER_LANGUAGE_NAME || "portuguese";
const FFMPEG = process.env.TETOS_FFMPEG_PATH || "ffmpeg";
const SAMPLE_RATE = 16000;
/** Abaixo disso (RMS) é silêncio/ruído de fundo — o Whisper inventa frase se receber isso. */
const SILENCE_RMS = 0.004;

let asrPromise = null;

async function loadAsr() {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (process.env.TETOS_MODELS_DIR) env.cacheDir = process.env.TETOS_MODELS_DIR;
      return pipeline("automatic-speech-recognition", MODEL, {
        dtype: { encoder_model: "q8", decoder_model_merged: "q8" }
      });
    })();
    asrPromise.catch(() => {
      asrPromise = null;
    });
  }
  return asrPromise;
}

function decodePcm(file, maxSeconds) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", file, "-t", String(maxSeconds), "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:1"];
    const child = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `ffmpeg saiu com ${code}`));
      const buf = Buffer.concat(chunks);
      const copy = new Float32Array(buf.byteLength / 4);
      new Uint8Array(copy.buffer).set(buf.subarray(0, copy.byteLength));
      resolve(copy);
    });
  });
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

async function handle(msg) {
  if (msg.warmup) {
    await loadAsr();
    return { id: msg.id, ok: true };
  }
  const audio = await decodePcm(msg.file, msg.maxSeconds ?? 300);
  const seconds = audio.length / SAMPLE_RATE;
  if (seconds < 0.3 || rms(audio) < SILENCE_RMS) return { id: msg.id, text: "", noSpeech: true, seconds };
  const asr = await loadAsr();
  const out = await asr(audio, {
    language: LANGUAGE,
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    max_new_tokens: 220,
    no_repeat_ngram_size: 4
  });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(" ") : out?.text ?? "";
  return { id: msg.id, text: String(text).trim(), seconds };
}

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;
  try {
    process.send?.(await handle(msg));
  } catch (error) {
    process.send?.({ id: msg.id, error: String(error?.message ?? error) });
  }
});

process.on("disconnect", () => process.exit(0));
