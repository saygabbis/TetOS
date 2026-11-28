import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

/**
 * Mensagem de voz da Teto: texto → fala → ogg/opus de "áudio de zap" (e da call do Discord).
 *  - fish: a voz DELA (modelo "Kasane Teto" do Fish Audio). Sem crédito ela não troca de voz: avisa e
 *    fica no texto até o crédito voltar (confere sozinha de tempos em tempos).
 *  - edge (grátis) / openai: vozes genéricas, só quando não tem Fish (ou TETOS_TTS_FALLBACK=edge).
 */

export const FISH_TETO_VOICE_ID = "78fd23c95bc1465ea6bb421530f49afa";
const CREDIT_CHECK_MS = 30 * 60_000;
const OUT_RECHECK_MS = 10 * 60_000;

/** Erro de "acabou o crédito da voz": quem chama decide o aviso (voiceNotes.creditNotice). */
export class VoiceCreditError extends Error {
  constructor(message = "sem crédito de voz") {
    super(message);
    this.code = "voice_no_credit";
  }
}
export const isVoiceCreditError = (error) => error?.code === "voice_no_credit";

/** Chaves do Fish: TETOS_FISH_API_KEY e/ou TETOS_FISH_API_KEYS (vírgula, ponto-e-vírgula ou espaço). */
export function parseFishKeys(env = process.env) {
  const raw = [env.TETOS_FISH_API_KEY, env.TETOS_FISH_API_KEYS].filter(Boolean).join(",");
  return [...new Set(raw.split(/[,;\s]+/).map((k) => k.replace(/^["']|["']$/g, "").trim()).filter(Boolean))];
}

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
    openai = null,
    fish = {
      keys: parseFishKeys(),
      voiceId: process.env.TETOS_FISH_VOICE_ID || FISH_TETO_VOICE_ID,
      model: process.env.TETOS_FISH_MODEL || "s2.1-pro",
      // Fala em português do Brasil (sem isso o modelo puxa o sotaque da voz de referência).
      language: process.env.TETOS_FISH_LANGUAGE ?? "pt-BR",
      lowCredit: Number(process.env.TETOS_FISH_LOW_CREDIT ?? 1),
      baseUrl: "https://api.fish.audio"
    },
    fallbackEdge = process.env.TETOS_TTS_FALLBACK === "edge",
    fetchImpl = (...a) => fetch(...a)
  } = {}) {
    const keys = [...new Set([...(fish?.keys ?? []), ...(fish?.apiKey ? [fish.apiKey] : [])])];
    this.fish = keys.length ? { ...fish, keys } : null;
    // Uma por vez; acabou o crédito de uma, passa pra próxima (igual o removebg).
    this.fishKeys = keys.map((key) => ({ key, credit: null, deadAt: 0 }));
    this.fishIdx = 0;
    this.fetch = fetchImpl;
    this.fallbackEdge = fallbackEdge;
    this.credit = { value: null, checkedAt: 0, out: false, outSince: 0, lowWarnedDay: null };
    this.noCreditAsks = new Map();
    this.provider = this.fish ? "fish" : provider === "openai" && openai?.apiKey ? "openai" : "edge";
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
    const last = this.lastByChat.get(chatId);
    // Pedido libera, mas nunca rajada: no mínimo 15 s entre um áudio e outro no mesmo chat.
    if (requested) return last == null || this.now() - last >= 15_000;
    return last == null || this.now() - last >= RATE_LIMIT_MS;
  }

  async synthesize(text) {
    const spoken = prepareSpokenText(text);
    if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) throw new Error("nada para falar");
    // Mesma fala de novo (repetição do modelo, reenvio): reaproveita o áudio, não gasta crédito.
    this.cache ??= new Map();
    const hit = this.cache.get(spoken);
    if (hit && this.now() - hit.at < 10 * 60_000) return hit.note;
    const note = await this.synthesizeNow(spoken);
    this.cache.set(spoken, { at: this.now(), note });
    if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
    return note;
  }

  async synthesizeNow(spoken) {
    const dir = mkdtempSync(join(tmpdir(), "tetos-voz-"));
    try {
      let audioFilePath = null;
      if (this.provider === "fish") {
        try {
          audioFilePath = await this.synthesizeFish(spoken, dir);
        } catch (error) {
          // A voz dela ou nada: só cai pra voz genérica se a dona pediu (TETOS_TTS_FALLBACK=edge).
          if (!this.fallbackEdge) throw error;
          console.warn(`[voz] Fish falhou, usando Edge: ${error?.message ?? error}`);
        }
      } else if (this.provider === "openai") {
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

  async synthesizeFish(spoken, dir) {
    const f = this.fish;
    if (this.credit.out && this.now() - this.credit.checkedAt < OUT_RECHECK_MS) throw new VoiceCreditError();
    if (this.credit.out) {
      await this.refreshCredit();
      if (this.credit.out) throw new VoiceCreditError();
    }
    const n = this.fishKeys.length;
    for (let step = 0; step < n; step += 1) {
      const i = (this.fishIdx + step) % n;
      const k = this.fishKeys[i];
      // Chave sem crédito: só tenta de novo depois de um tempo (pode ter sido recarregada).
      if (k.deadAt && this.now() - k.deadAt < OUT_RECHECK_MS) continue;
      const res = await this.fetch(`${f.baseUrl ?? "https://api.fish.audio"}/v1/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${k.key}`, model: f.model || "s2.1-pro" },
        body: JSON.stringify({
          text: spoken,
          reference_id: f.voiceId || FISH_TETO_VOICE_ID,
          format: "mp3",
          mp3_bitrate: 64,
          latency: "balanced",
          normalize: true,
          ...(f.language ? { language: f.language } : {})
        }),
        signal: AbortSignal.timeout(60_000)
      });
      if (res.status === 402 || res.status === 401) {
        k.deadAt = this.now();
        k.credit = res.status === 402 ? 0 : k.credit;
        console.warn(`[voz] chave ${i + 1}/${n} do Fish ${res.status === 402 ? "sem crédito" : "recusada"}; ${n > 1 ? "tentando a próxima" : "sem outra chave"}`);
        continue;
      }
      if (!res.ok) throw new Error(`Fish TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
      this.fishIdx = i;
      k.deadAt = 0;
      const file = join(dir, "voz.mp3");
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      if (this.credit.out) this.credit.out = false;
      if (this.now() - this.credit.checkedAt > CREDIT_CHECK_MS) this.refreshCredit().catch(() => {});
      return file;
    }
    this.markOutOfCredit();
    throw new VoiceCreditError();
  }

  markOutOfCredit() {
    if (!this.credit.out) this.credit.outSince = this.now();
    this.credit.out = true;
    this.credit.checkedAt = this.now();
    console.warn("[voz] Fish Audio sem crédito em todas as chaves: voz desligada até recarregar");
  }

  /** Saldo do Fish (US$, soma das chaves). Atualiza `credit.value` e liga/desliga o "sem crédito". */
  async refreshCredit() {
    if (!this.fish) return null;
    this.credit.checkedAt = this.now();
    let total = 0;
    let known = 0;
    for (const k of this.fishKeys) {
      try {
        const res = await this.fetch(`${this.fish.baseUrl ?? "https://api.fish.audio"}/wallet/self/api-credit`, {
          headers: { Authorization: `Bearer ${k.key}` },
          signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) {
          if (res.status === 401) k.deadAt = this.now();
          continue;
        }
        const value = Number((await res.json())?.credit);
        if (!Number.isFinite(value)) continue;
        // Saldo é só informação: chave com 0 aqui ainda pode ter crédito grátis. Quem marca "sem
        // crédito" é o Fish recusando gerar (402); saldo positivo de novo = recarregaram.
        k.credit = value;
        if (value > 0) k.deadAt = 0;
        total += Math.max(0, value);
        known += 1;
      } catch {}
    }
    if (!known) return this.credit.value;
    this.credit.value = total;
    // Começa pela chave com crédito (a atual, se ainda tiver).
    if (this.fishKeys[this.fishIdx]?.deadAt) {
      const alive = this.fishKeys.findIndex((k) => !k.deadAt);
      if (alive >= 0) this.fishIdx = alive;
    }
    if (total > 0 && this.credit.out) {
      this.credit.out = false;
      this.noCreditAsks.clear();
      console.log(`[voz] crédito do Fish voltou (US$ ${total.toFixed(2)})`);
    }
    return this.credit.value;
  }

  /** Estado pra o resto do bot (prompt, call, status). */
  status() {
    const low = this.fish && this.credit.value != null && this.credit.value > 0 && this.credit.value < (this.fish.lowCredit ?? 1);
    return {
      provider: this.provider,
      realVoice: this.provider === "fish",
      out: this.provider === "fish" && this.credit.out,
      low: Boolean(low),
      credit: this.credit.value
    };
  }

  /**
   * Aviso no jeito dela quando a voz acabou (ou tá acabando). Insistiu = aviso diferente, dizendo quando volta.
   * @returns {string | null}
   */
  creditNotice(chatId, { kind = "out", isOwner = false } = {}) {
    if (kind === "low") {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (this.credit.lowWarnedDay === day) return null;
      this.credit.lowWarnedDay = day;
      const v = this.credit.value != null ? ` (sobrou uns US$ ${this.credit.value.toFixed(2)})` : "";
      return isOwner
        ? `ei, meu crédito de voz tá acabando${v}... se quiser que eu continue falando com a minha voz, recarrega lá no Fish 🥺`
        : `aviso: minha voz tá quase sem crédito${v}, daqui a pouco eu fico só no texto`;
    }
    const n = (this.noCreditAsks.get(chatId) ?? 0) + 1;
    this.noCreditAsks.set(chatId, n);
    const mins = Math.max(1, Math.ceil((OUT_RECHECK_MS - (this.now() - this.credit.checkedAt)) / 60_000));
    if (n === 1) {
      return isOwner
        ? "acabou meu crédito de voz 😭 sem ele eu não consigo falar com a minha voz, então fico no texto até você recarregar lá no Fish"
        : "acabou meu crédito de voz 😭 por enquanto só consigo te responder escrevendo";
    }
    if (n === 2) {
      return isOwner
        ? `ainda sem crédito... minha voz volta assim que você colocar crédito no Fish Audio, eu confiro sozinha (próxima olhada em uns ${mins} min)`
        : "minha voz só volta quando a Gabbis recarregar o crédito, aí eu volto a mandar áudio, prometo";
    }
    return n % 3 === 0 ? "JÁ FALEI que tô sem voz 😤 quando o crédito voltar eu falo, até lá é texto" : null;
  }

  markSent(chatId) {
    this.lastByChat.set(chatId, this.now());
  }
}

