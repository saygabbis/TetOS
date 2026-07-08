import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
    outputDir = "./data/media/generated",
    maxPer10Min = 3
  } = {}) {
    this.enabled = enabled !== false;
    this.provider = provider === "huggingface" ? "huggingface" : "pollinations";
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
      if (this.provider === "huggingface") {
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
