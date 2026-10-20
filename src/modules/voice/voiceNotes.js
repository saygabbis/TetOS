import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

/**
 * Mensagem de voz da Teto: texto → fala (TTS neural do Edge, grátis) → ogg/opus de "áudio de zap".
 * Voz e tom configuráveis (TETOS_TTS_VOICE / TETOS_TTS_PITCH / TETOS_TTS_RATE).
 */

const MAX_CHARS = 400;
const RATE_LIMIT_MS = 10 * 60_000;

/** O que vai ser falado: sem emoji, link, @, markdown; risada de teclado vira risada falada. */
export function prepareSpokenText(text = "") {
  return String(text ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@(\S+)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\b(?:k{3,}|(?:ks){2,}k?|(?:rs){2,}|(?:ha){2,}h?|(?:he){2,}|kk)\b/gi, " ha ha ")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/([!?.])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

function toOggOpus(mp3Path, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", mp3Path, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1"];
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim() || `ffmpeg ${code}`))));
  });
}

export class VoiceNotes {
  constructor({
    enabled = process.env.TETOS_TTS_ENABLED !== "false",
    voice = process.env.TETOS_TTS_VOICE || "pt-BR-FranciscaNeural",
    pitch = process.env.TETOS_TTS_PITCH || "+22%",
    rate = process.env.TETOS_TTS_RATE || "+6%",
    ffmpegPath = process.env.TETOS_FFMPEG_PATH || ffmpegInstaller.path,
    now = () => Date.now()
  } = {}) {
    this.enabled = enabled;
    this.voice = voice;
    this.pitch = pitch;
    this.rate = rate;
    this.ffmpegPath = ffmpegPath;
    this.now = now;
    this.lastByChat = new Map();
  }

  /** Áudio espontâneo é raro; quando pedem ("manda áudio"), libera. */
  canSend(chatId, { requested = false } = {}) {
    if (!this.enabled) return false;
    if (requested) return true;
    const last = this.lastByChat.get(chatId);
    return last == null || this.now() - last >= RATE_LIMIT_MS;
  }

  async synthesize(text) {
    const spoken = prepareSpokenText(text);
    if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) throw new Error("nada para falar");
    const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
    const dir = mkdtempSync(join(tmpdir(), "tetos-voz-"));
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioFilePath } = await tts.toFile(dir, spoken, { pitch: this.pitch, rate: this.rate });
      tts.close?.();
      const ogg = await toOggOpus(audioFilePath, this.ffmpegPath);
      // ~13 caracteres por segundo de fala: dá pra estimar a duração (e o tempo "gravando…").
      const seconds = Math.max(1, Math.round(spoken.length / 13));
      return { audio: ogg, seconds, spoken };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  markSent(chatId) {
    this.lastByChat.set(chatId, this.now());
  }
}

