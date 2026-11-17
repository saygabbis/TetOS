import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RATE_WINDOW_MS = 10 * 60 * 1000;
const userTimestamps = new Map();

function checkRateLimit(userId, maxPer10Min) {
  const uid = String(userId ?? "default");
  const now = Date.now();
  const prev = (userTimestamps.get(uid) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (prev.length >= maxPer10Min) {
    return { allowed: false, retryAfterMs: RATE_WINDOW_MS - (now - prev[0]) };
  }
  prev.push(now);
  userTimestamps.set(uid, prev);
  return { allowed: true };
}

async function fetchPollinations(prompt) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`pollinations HTTP ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength < 512) {
    throw new Error("pollinations returned empty image");
  }
  return buffer;
}

async function fetchOpenAI(prompt, { apiKey, baseUrl = "https://api.openai.com/v1", model = "gpt-image-1-mini", quality = "low" }) {
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, size: "1024x1024", quality, n: 1 }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai image HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("openai image: resposta sem imagem");
  return Buffer.from(b64, "base64");
}

function friendlyOpenAIImageError(error) {
  const msg = String(error?.message ?? error ?? "");
  if (/insufficient_quota|billing/i.test(msg)) return "acabou o saldo da OpenAI";
  if (/HTTP 429/.test(msg)) return "a OpenAI tá no limite de imagens por minuto, tenta de novo daqui a pouco";
  if (/moderation|safety|content_policy|rejected/i.test(msg)) return "a OpenAI recusou esse pedido (regra de conteúdo)";
  if (/HTTP 40[13]/.test(msg)) return "a chave da OpenAI não tem acesso a imagens";
  return "a OpenAI não conseguiu gerar agora";
}

/** Preço aproximado do gpt-image-1-mini por imagem 1024x1024. */
const OPENAI_IMAGE_USD = { low: 0.006, medium: 0.015, high: 0.052 };

async function fetchHuggingFace(prompt, token, model) {
  const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ inputs: prompt })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`huggingface HTTP ${res.status}: ${body.slice(0, 120)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength < 512) {
    throw new Error("huggingface returned empty image");
  }
  return buffer;
}

export class ImageGenerationService {
  constructor({
    enabled = true,
    provider = "pollinations",
    hfToken = "",
    hfModel = "black-forest-labs/FLUX.1-schnell",
    openai = null,
    outputDir = "./data/media/generated",
    maxPer10Min = 3
  } = {}) {
    this.enabled = enabled !== false;
    this.openai = openai?.apiKey ? openai : null;
    this.provider =
      provider === "huggingface" ? "huggingface" : provider === "openai" && this.openai ? "openai" : "pollinations";
    this.hfToken = String(hfToken ?? "").trim();
    this.hfModel = hfModel;
    this.outputDir = outputDir;
    this.maxPer10Min = Math.max(1, Number(maxPer10Min) || 3);
  }

  isEnabled() {
    if (!this.enabled) return false;
    if (this.provider === "huggingface" && !this.hfToken) return false;
    return true;
  }

  async generate({ prompt, userId = "default" } = {}) {
    const cleanPrompt = String(prompt ?? "").trim();
    if (!cleanPrompt) {
      return { ok: false, error: "prompt vazio" };
    }
    if (!this.isEnabled()) {
      return { ok: false, error: "geração de imagem desabilitada" };
    }

    const rate = checkRateLimit(userId, this.maxPer10Min);
    if (!rate.allowed) {
      return {
        ok: false,
        error: "limite de gerações atingido — tenta de novo em alguns minutos",
        retryAfterMs: rate.retryAfterMs
      };
    }

    let buffer;
    try {
      if (this.provider === "openai") {
        try {
          try {
            buffer = await fetchOpenAI(cleanPrompt, this.openai);
          } catch (error) {
            // 429 = limite por minuto da conta: espera um pouco e tenta mais uma vez.
            if (!/HTTP 429/.test(String(error?.message))) throw error;
            await new Promise((r) => setTimeout(r, 8000));
            buffer = await fetchOpenAI(cleanPrompt, this.openai);
          }
          this.openai.usage?.add(OPENAI_IMAGE_USD[this.openai.quality] ?? OPENAI_IMAGE_USD.low, "imagem");
        } catch (error) {
          // Recusa de conteúdo ou falha da OpenAI: tenta o gerador grátis.
          console.warn(`[imagem] OpenAI falhou, usando pollinations: ${error?.message ?? error}`);
          try {
            buffer = await fetchPollinations(cleanPrompt);
          } catch {
            return { ok: false, error: friendlyOpenAIImageError(error) };
          }
        }
      } else if (this.provider === "huggingface") {
        buffer = await fetchHuggingFace(cleanPrompt, this.hfToken, this.hfModel);
      } else {
        buffer = await fetchPollinations(cleanPrompt);
      }
    } catch (error) {
      if (this.provider === "pollinations" && this.hfToken) {
        try {
          buffer = await fetchHuggingFace(cleanPrompt, this.hfToken, this.hfModel);
        } catch {
          return { ok: false, error: error.message ?? String(error) };
        }
      } else {
        return { ok: false, error: error.message ?? String(error) };
      }
    }

    mkdirSync(this.outputDir, { recursive: true });
    const hash = createHash("sha256").update(cleanPrompt).digest("hex").slice(0, 16);
    const filePath = join(this.outputDir, `gen-${Date.now()}-${hash}.png`);
    writeFileSync(filePath, buffer);

    return {
      ok: true,
      buffer,
      filePath,
      provider: this.provider,
      prompt: cleanPrompt
    };
  }
}
