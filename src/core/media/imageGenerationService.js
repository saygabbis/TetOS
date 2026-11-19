import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ImageCostStats, PendingImageRequests, estimateImage, imageUsageUsd, sizeFor } from "./imageStudio.js";

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

const MIME_BY_EXT = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** Uma chamada da API de imagem (gera ou edita). Devolve { buffer, usage }. */
async function callOpenAIImage({ apiKey, baseUrl = "https://api.openai.com/v1", model, prompt, quality, size, complexity = null, images = [], safetyId = null }) {
  let res;
  if (images.length) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("quality", quality);
    form.append("size", size);
    form.append("n", "1");
    const field = images.length > 1 ? "image[]" : "image";
    for (const path of images) {
      const type = MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/png";
      form.append(field, new Blob([readFileSync(path)], { type }), basename(path).replace(/\.[^.]+$/, "") + (type === "image/jpeg" ? ".jpg" : `.${type.split("/")[1]}`));
    }
    res = await fetch(`${baseUrl}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(300_000)
    });
  } else {
    res = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt, size, quality, n: 1, ...(complexity ? { complexity } : {}), ...(safetyId ? { safety_identifier: safetyId } : {}) }),
      signal: AbortSignal.timeout(300_000)
    });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai image HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("openai image: resposta sem imagem");
  return { buffer: Buffer.from(b64, "base64"), usage: json.usage ?? null };
}

export function friendlyOpenAIImageError(error) {
  const msg = String(error?.message ?? error ?? "");
  if (/insufficient_quota|billing/i.test(msg)) return "acabou o saldo da OpenAI";
  if (/HTTP 429/.test(msg)) return "a OpenAI tá no limite de imagens por minuto, tenta de novo daqui a pouco";
  if (/moderation|safety|content_policy|rejected/i.test(msg)) return "a OpenAI recusou esse pedido (regra de conteúdo)";
  if (/HTTP 40[13]/.test(msg)) return "a chave da OpenAI não tem acesso a imagens";
  if (/HTTP 400/.test(msg) && /size|quality|complexity|image/i.test(msg)) return `a OpenAI não aceitou essas opções (${msg.replace(/^.*?HTTP 400: /, "").slice(0, 120)})`;
  return "a OpenAI não conseguiu gerar agora";
}

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

const MODEL_LABEL = (model = "") =>
  /sunburst/i.test(model) ? "GPT Image 2.6 Sunburst" : /flare/i.test(model) ? "GPT Image 2.6 Flare" : model;

/**
 * Geração e edição de imagem.
 *  - eco (padrão): gpt-image-2.6-flare em qualidade baixa — barato e rápido, roda direto.
 *  - hd (modo bom): gpt-image-2.6-sunburst em alta/ultra/máxima — antes mostra a estimativa e
 *    espera "sim" (ver `plan()` + PendingImageRequests).
 */
export class ImageGenerationService {
  constructor({
    enabled = true,
    provider = "pollinations",
    hfToken = "",
    hfModel = "black-forest-labs/FLUX.1-schnell",
    openai = null,
    outputDir = "./data/media/generated",
    maxPer10Min = 3,
    statsPath = null,
    hdOwnerOnly = true
  } = {}) {
    this.enabled = enabled !== false;
    this.openai = openai?.apiKey ? openai : null;
    this.provider =
      provider === "huggingface" ? "huggingface" : provider === "openai" && this.openai ? "openai" : "pollinations";
    this.hfToken = String(hfToken ?? "").trim();
    this.hfModel = hfModel;
    this.outputDir = outputDir;
    this.maxPer10Min = Math.max(1, Number(maxPer10Min) || 3);
    this.hdOwnerOnly = hdOwnerOnly !== false;
    this.stats = new ImageCostStats({ path: statsPath });
    this.pending = new PendingImageRequests();
    const o = this.openai ?? {};
    this.tiers = {
      eco: { model: o.ecoModel ?? o.model ?? "gpt-image-2.6-flare", quality: o.ecoQuality ?? o.quality ?? "low", complexity: o.ecoComplexity ?? "medium" },
      hd: { model: o.hdModel ?? "gpt-image-2.6-sunburst", quality: o.hdQuality ?? "high", complexity: o.hdComplexity ?? "high" }
    };
  }

  isEnabled() {
    if (!this.enabled) return false;
    if (this.provider === "huggingface" && !this.hfToken) return false;
    return true;
  }

  /** Modo bom / edição precisam da OpenAI. */
  canUseOpenAI() {
    return this.isEnabled() && this.provider === "openai" && Boolean(this.openai);
  }

  /** Quem pode pedir o modo bom (custa mais). */
  canUseHd({ isOwner = false } = {}) {
    return this.canUseOpenAI() && (!this.hdOwnerOnly || isOwner);
  }

  /**
   * Monta o pedido (sem gastar nada): modelo, qualidade, tamanho e estimativa.
   * @param {{ tier?: "eco"|"hd", prompt: string, quality?: string|null, size?: string|null, images?: string[] }} p
   */
  plan({ tier = "eco", prompt, quality = null, size = null, images = [] } = {}) {
    const base = this.tiers[tier] ?? this.tiers.eco;
    const q = quality && !(tier === "eco" && ["xhigh", "max"].includes(quality)) ? quality : base.quality;
    const sz = size ?? sizeFor("1:1");
    const plan = {
      tier,
      prompt: String(prompt ?? "").trim(),
      model: base.model,
      modelLabel: MODEL_LABEL(base.model),
      quality: q,
      complexity: base.complexity,
      size: sz,
      images: [...images],
      inputImages: images.length,
      edit: images.length > 0
    };
    plan.estimate = estimateImage({ model: plan.model, quality: q, size: sz, prompt: plan.prompt, inputImages: images.length, stats: this.stats });
    return plan;
  }

  /** Gera/edita a partir de um plano (já confirmado, se for modo bom). */
  async runPlan(plan, { userId = "default" } = {}) {
    if (!plan?.prompt) return { ok: false, error: "prompt vazio" };
    if (!this.canUseOpenAI()) return { ok: false, error: "a geração pela OpenAI tá desligada" };
    if (plan.tier !== "hd") {
      const rate = checkRateLimit(userId, this.maxPer10Min);
      if (!rate.allowed) return { ok: false, error: "limite de gerações atingido — tenta de novo em alguns minutos", retryAfterMs: rate.retryAfterMs };
    }
    const started = Date.now();
    const call = () =>
      callOpenAIImage({
        apiKey: this.openai.apiKey,
        baseUrl: this.openai.baseUrl,
        model: plan.model,
        prompt: plan.prompt,
        quality: plan.quality,
        size: plan.size,
        complexity: plan.complexity,
        images: plan.images
      });
    let out;
    try {
      try {
        out = await call();
      } catch (error) {
        // 429 = limite por minuto da conta: espera um pouco e tenta mais uma vez.
        if (!/HTTP 429/.test(String(error?.message))) throw error;
        await new Promise((r) => setTimeout(r, 8000));
        out = await call();
      }
    } catch (error) {
      console.warn(`[imagem] ${plan.model} falhou: ${error?.message ?? error}`);
      return { ok: false, error: friendlyOpenAIImageError(error) };
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const usd = out.usage ? imageUsageUsd(plan.model, out.usage) : plan.estimate?.usd ?? 0;
    this.openai.usage?.add?.(usd, plan.tier === "hd" ? "imagem (modo bom)" : "imagem", out.usage);
    if (out.usage) this.stats.observe({ model: plan.model, quality: plan.quality, size: plan.size, usage: out.usage, seconds, inputImages: plan.inputImages });
    const filePath = this._save(out.buffer, plan.prompt);
    return { ok: true, buffer: out.buffer, filePath, provider: "openai", model: plan.model, quality: plan.quality, size: plan.size, usage: out.usage, usd, seconds, prompt: plan.prompt, edit: plan.edit };
  }

  _save(buffer, prompt) {
    mkdirSync(this.outputDir, { recursive: true });
    const hash = createHash("sha256").update(String(prompt)).digest("hex").slice(0, 16);
    const filePath = join(this.outputDir, `gen-${Date.now()}-${hash}.png`);
    writeFileSync(filePath, buffer);
    return filePath;
  }

  /** Geração simples (modo econômico), com reservas grátis se a OpenAI falhar. */
  async generate({ prompt, userId = "default", quality = null, size = null } = {}) {
    const cleanPrompt = String(prompt ?? "").trim();
    if (!cleanPrompt) {
      return { ok: false, error: "prompt vazio" };
    }
    if (!this.isEnabled()) {
      return { ok: false, error: "geração de imagem desabilitada" };
    }

    if (this.provider === "openai") {
      const result = await this.runPlan(this.plan({ tier: "eco", prompt: cleanPrompt, quality, size }), { userId });
      if (result.ok || result.retryAfterMs) return result;
      // Falha da OpenAI (fora limite de uso): tenta o gerador grátis.
      try {
        const buffer = await fetchPollinations(cleanPrompt);
        return { ok: true, buffer, filePath: this._save(buffer, cleanPrompt), provider: "pollinations", prompt: cleanPrompt };
      } catch {
        return result;
      }
    }

    const rate = checkRateLimit(userId, this.maxPer10Min);
    if (!rate.allowed) {
      return { ok: false, error: "limite de gerações atingido — tenta de novo em alguns minutos", retryAfterMs: rate.retryAfterMs };
    }
    let buffer;
    try {
      buffer = this.provider === "huggingface" ? await fetchHuggingFace(cleanPrompt, this.hfToken, this.hfModel) : await fetchPollinations(cleanPrompt);
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
    return { ok: true, buffer, filePath: this._save(buffer, cleanPrompt), provider: this.provider, prompt: cleanPrompt };
  }
}
