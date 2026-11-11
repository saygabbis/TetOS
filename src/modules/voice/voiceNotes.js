import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    now = () => Date.now(),
    /** edge (grátis) | openai (gpt-4o-mini-tts; se falhar, cai pro Edge). */
    provider = "edge",
    openai = null
  } = {}) {
    this.provider = provider === "openai" && openai?.apiKey ? "openai" : "edge";
    this.openai = openai;
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
    const dir = mkdtempSync(join(tmpdir(), "tetos-voz-"));
    try {
      let audioFilePath = null;
      if (this.provider === "openai") {
        try {
          audioFilePath = await this.synthesizeOpenAI(spoken, dir);
        } catch (error) {
          console.warn(`[voz] OpenAI TTS falhou, usando Edge: ${error?.message ?? error}`);
        }
      }
      if (!audioFilePath) {
        const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
        const tts = new MsEdgeTTS();
        await tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        ({ audioFilePath } = await tts.toFile(dir, spoken, { pitch: this.pitch, rate: this.rate }));
        tts.close?.();
      }
      const ogg = await toOggOpus(audioFilePath, this.ffmpegPath);
      // ~13 caracteres por segundo de fala: dá pra estimar a duração (e o tempo "gravando…").
      const seconds = Math.max(1, Math.round(spoken.length / 13));
      return { audio: ogg, seconds, spoken };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async synthesizeOpenAI(spoken, dir) {
    const o = this.openai;
    const res = await fetch(`${o.baseUrl ?? "https://api.openai.com/v1"}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model ?? "gpt-4o-mini-tts",
        voice: o.voice ?? "nova",
        input: spoken,
        ...(o.instructions ? { instructions: o.instructions } : {}),
        response_format: "mp3"
      }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const file = join(dir, "voz.mp3");
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    // ~US$ 0,015 por minuto de fala; ~13 caracteres por segundo.
    o.usage?.add((spoken.length / 13 / 60) * 0.015, "voz");
    return file;
  }

  markSent(chatId) {
    this.lastByChat.set(chatId, this.now());
  }
}

