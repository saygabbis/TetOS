import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Peças da geração/edição de imagem da Teto que não dependem de plataforma:
 *  - opções do comando (".gerarhd ultra 16:9 <descrição>")
 *  - estimativa de tokens/US$/tempo (tabela medida + o que ela aprende com o gasto real)
 *  - pedido pendente esperando "sim" (modo bom custa mais: só gera depois de confirmar)
 *
 * Modelos (OpenAI, nov/2026): gpt-image-2.6-flare (rápido, economia) e gpt-image-2.6-sunburst
 * (detalhe/edição, modo bom). Mesmo preço por token: texto US$5/M, imagem de entrada US$8/M,
 * imagem de saída US$30/M. A OpenAI não publica preço por imagem do 2.6: a conta é por token.
 */

/** US$ por 1M tokens: [texto entrada, imagem entrada, saída]. */
const IMAGE_PRICES = [
  [/^gpt-image-2\.[56]/, [5, 8, 30]],
  [/^gpt-image-2/, [5, 8, 30]],
  [/^gpt-image-1\.5/, [5, 8, 32]],
  [/^gpt-image-1-mini/, [2, 2.5, 8]],
  [/^gpt-image-1/, [5, 10, 40]]
];

export function imagePriceFor(model = "") {
  const m = String(model).toLowerCase();
  return IMAGE_PRICES.find(([re]) => re.test(m))?.[1] ?? [5, 8, 30];
}

/** Custo de uma resposta da API de imagem a partir do `usage` dela. */
export function imageUsageUsd(model, usage = {}) {
  const [textIn, imageIn, out] = imagePriceFor(model);
  const inDetails = usage?.input_tokens_details ?? {};
  const imageTokens = Number(inDetails.image_tokens ?? 0) || 0;
  const textTokens = Number(inDetails.text_tokens ?? Math.max(0, (Number(usage?.input_tokens) || 0) - imageTokens)) || 0;
  const output = Number(usage?.output_tokens ?? 0) || 0;
  return (textTokens * textIn + imageTokens * imageIn + output * out) / 1_000_000;
}

// Qualidade: palavra do pedido → valor da API.
const QUALITY_WORDS = new Map([
  ["baixa", "low"], ["low", "low"], ["eco", "low"], ["economica", "low"], ["econômica", "low"],
  ["media", "medium"], ["média", "medium"], ["medium", "medium"], ["mid", "medium"],
  ["alta", "high"], ["high", "high"], ["hd", "high"], ["boa", "high"],
  ["ultra", "xhigh"], ["xhigh", "xhigh"], ["altissima", "xhigh"], ["altíssima", "xhigh"],
  ["max", "max"], ["maxima", "max"], ["máxima", "max"], ["maximo", "max"], ["máximo", "max"]
]);

export const QUALITY_LABEL = { low: "baixa", medium: "média", high: "alta", xhigh: "ultra", max: "máxima", auto: "automática" };

// Formatos (múltiplos de 16, entre 655.360 e 8.294.400 pixels, proporção até 3:1).
const ASPECTS = {
  "1:1": ["1024x1024", "2048x2048"],
  "3:2": ["1536x1024", "2160x1440"],
  "2:3": ["1024x1536", "1440x2160"],
  "4:3": ["1024x768", "2048x1536"],
  "3:4": ["768x1024", "1536x2048"],
  "16:9": ["1536x864", "2560x1440"],
  "9:16": ["864x1536", "1440x2560"]
};
const ASPECT_WORDS = new Map([
  ["quadrada", "1:1"], ["quadrado", "1:1"], ["square", "1:1"],
  ["horizontal", "3:2"], ["landscape", "3:2"],
  ["vertical", "2:3"], ["portrait", "2:3"],
  ["widescreen", "16:9"], ["wallpaper", "16:9"],
  ["story", "9:16"], ["stories", "9:16"], ["celular", "9:16"]
]);

export function sizeFor(aspect = "1:1", big = false) {
  const pair = ASPECTS[aspect] ?? ASPECTS["1:1"];
  return big ? pair[1] : pair[0];
}

export function pixelsOf(size = "1024x1024") {
  const [w, h] = String(size).split("x").map(Number);
  return (w || 1024) * (h || 1024);
}

/**
 * Opções no começo do comando (só no começo, pra "alta montanha" no meio do texto continuar texto):
 *   ".gerarhd ultra 16:9 2k gato astronauta" → { quality: "xhigh", aspect: "16:9", big: true, prompt }
 */
export function parseImageArgs(args = []) {
  const tokens = (Array.isArray(args) ? args : String(args ?? "").split(/\s+/)).map(String).filter(Boolean);
  let quality = null;
  let aspect = null;
  let big = false;
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase().replace(/[,;]$/, "");
    if (!quality && QUALITY_WORDS.has(t)) {
      quality = QUALITY_WORDS.get(t);
      continue;
    }
    if (!aspect && ASPECTS[t]) {
      aspect = t;
      continue;
    }
    if (!aspect && ASPECT_WORDS.has(t)) {
      aspect = ASPECT_WORDS.get(t);
      continue;
    }
    if (!big && /^(2k|grande|big)$/.test(t)) {
      big = true;
      continue;
    }
    break;
  }
  const prompt = tokens.slice(i).join(" ").trim();
  return { quality, aspect: aspect ?? "1:1", big, size: sizeFor(aspect ?? "1:1", big), prompt };
}

// Tokens de saída por megapixel (1024x1024), medidos em nov/2026: flare low (complexity medium) = 824,
// sunburst high = 1756. Os outros são chute proporcional até ela aprender com o uso real.
const BASE_OUT_PER_MP = { low: 824, medium: 1250, high: 1756, xhigh: 2600, max: 3600, auto: 1756 };
const BASE_SECONDS_PER_MP = { low: 7, medium: 16, high: 34, xhigh: 50, max: 70, auto: 34 };
// Imagem de entrada na edição: sem tabela oficial; chute por imagem até aprender.
const BASE_INPUT_IMAGE_TOKENS = 1200;
const MP = 1024 * 1024;

/** O que ela aprendeu do gasto real (média móvel por modelo + qualidade, normalizada por megapixel). */
export class ImageCostStats {
  constructor({ path = null } = {}) {
    this.path = path;
    this.data = { keys: {} };
    try {
      if (path && existsSync(path)) this.data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      /* começa do zero */
    }
    this.data.keys ??= {};
  }

  key(model, quality) {
    return `${model}|${quality}`;
  }

  get(model, quality) {
    return this.data.keys[this.key(model, quality)] ?? null;
  }

  observe({ model, quality, size, usage, seconds, inputImages = 0 }) {
    const out = Number(usage?.output_tokens ?? 0);
    if (!model || !out) return;
    const mp = pixelsOf(size) / MP;
    const k = this.key(model, quality);
    const prev = this.data.keys[k];
    const mix = (a, b) => (a == null ? b : Math.round(a * 0.7 + b * 0.3));
    const imgIn = Number(usage?.input_tokens_details?.image_tokens ?? 0);
    this.data.keys[k] = {
      outPerMp: mix(prev?.outPerMp, out / mp),
      secondsPerMp: seconds ? mix(prev?.secondsPerMp, seconds / mp) : prev?.secondsPerMp ?? null,
      inputPerImage: inputImages && imgIn ? mix(prev?.inputPerImage, imgIn / inputImages) : prev?.inputPerImage ?? null,
      samples: (prev?.samples ?? 0) + 1,
      at: new Date().toISOString()
    };
    this.save();
  }

  save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2));
    } catch {
      /* estimativa: não derruba nada */
    }
  }
}

/** Estimativa de uma geração/edição antes de rodar. */
export function estimateImage({ model, quality = "low", size = "1024x1024", prompt = "", inputImages = 0, stats = null }) {
  const mp = pixelsOf(size) / MP;
  const learned = stats?.get?.(model, quality) ?? null;
  const outPerMp = learned?.outPerMp ?? BASE_OUT_PER_MP[quality] ?? BASE_OUT_PER_MP.high;
  const outputTokens = Math.round(outPerMp * mp);
  const textTokens = Math.ceil(String(prompt).length / 3.5) + 20;
  const imageTokens = Math.round(inputImages * (learned?.inputPerImage ?? BASE_INPUT_IMAGE_TOKENS));
  const usd = imageUsageUsd(model, {
    input_tokens: textTokens + imageTokens,
    input_tokens_details: { text_tokens: textTokens, image_tokens: imageTokens },
    output_tokens: outputTokens
  });
  const seconds = Math.round((learned?.secondsPerMp ?? BASE_SECONDS_PER_MP[quality] ?? 34) * mp + inputImages * 3);
  return { outputTokens, inputTokens: textTokens + imageTokens, usd, seconds, learned: Boolean(learned?.samples) };
}

// Cotação do dólar só pra mostrar ~R$ (cache de 6h; se falhar, mostra só US$).
let usdBrlCache = { at: 0, rate: null };
export async function usdToBrlRate({ fetchImpl = globalThis.fetch } = {}) {
  if (usdBrlCache.rate && Date.now() - usdBrlCache.at < 6 * 3600_000) return usdBrlCache.rate;
  // AwesomeAPI às vezes devolve 429 pro IP da VPS; open.er-api.com fica de reserva.
  const sources = [
    ["https://economia.awesomeapi.com.br/json/last/USD-BRL", (j) => j?.USDBRL?.bid],
    ["https://open.er-api.com/v6/latest/USD", (j) => j?.rates?.BRL]
  ];
  for (const [url, pick] of sources) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const rate = Number(pick(await res.json()));
      if (rate > 1 && rate < 20) {
        usdBrlCache = { at: Date.now(), rate };
        break;
      }
    } catch {
      /* tenta a próxima; sem nenhuma: só US$ */
    }
  }
  return usdBrlCache.rate;
}

const fmtTokens = (n) => new Intl.NumberFormat("pt-BR").format(Math.round(n));
export function fmtUsd(v) {
  const n = Number(v ?? 0);
  return `US$ ${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`.replace(".", ",");
}
const fmtBrl = (v) => `R$ ${Number(v).toFixed(2).replace(".", ",")}`;

/** Texto do "vai custar ~X, confirma?". */
export function formatImageEstimate(plan, { style = { b: (t) => `*${t}*`, code: (t) => t }, brlRate = null, prefix = "." } = {}) {
  const e = plan.estimate;
  const what = plan.edit ? "editar" : "gerar";
  const money = `~${fmtUsd(e.usd)}${brlRate ? ` (~${fmtBrl(e.usd * brlRate)})` : ""}`;
  return [
    `💎 ${style.b(`modo bom: ${what} com ${plan.modelLabel}`)} · qualidade ${QUALITY_LABEL[plan.quality] ?? plan.quality} · ${plan.size.replace("x", "×")}${plan.edit ? ` · ${plan.inputImages} imagem(ns) de base` : ""}`,
    `🧮 estimativa: ~${fmtTokens(e.outputTokens + e.inputTokens)} tokens · ${style.b(money)}${e.learned ? "" : " (chute inicial, vou aprendendo)"}`,
    `⏱️ leva ${e.seconds < 60 ? `uns ${e.seconds}s` : `~${Math.round(e.seconds / 60)} min`}`,
    `responde ${style.b("sim")} pra eu fazer ou ${style.b("não")} pra cancelar (vale 3 min)`
  ].join("\n");
}

const CONFIRM_RE = /^\s*[.!/]?(?:sim+|s|ss+|confirm[oa]r?|pode(?:\s+(?:fazer|gerar|ir|mandar))?|bora|manda(?:\s+ver)?|vai|faz|gera|ok|okay|yes|claro|isso|quero)\s*[!.👍✅]*\s*$/iu;
const CANCEL_RE = /^\s*[.!/]?(?:n[aã]o+|nn+|cancela(?:r)?|deixa(?:\s+pra\s+l[aá])?|esquece|para|n[aã]o\s+quero|no|nope)\s*[!.]*\s*$/iu;

/** Pedidos do modo bom esperando o "sim" de quem pediu. */
export class PendingImageRequests {
  constructor({ ttlMs = 3 * 60_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.items = new Map();
  }

  static keyOf({ platform = "whatsapp", chatId, userId }) {
    return `${platform}:${chatId}:${userId}`;
  }

  set(key, plan) {
    this.items.set(key, { plan, at: this.now() });
  }

  peek(key) {
    const it = this.items.get(key);
    if (!it) return null;
    if (this.now() - it.at > this.ttlMs) {
      this.items.delete(key);
      return null;
    }
    return it.plan;
  }

  /** "sim" → { confirm: plan } · "não" → { cancel: plan } · outra coisa → null (o pedido continua de pé). */
  handleReply(key, text = "") {
    const plan = this.peek(key);
    if (!plan) return null;
    if (CONFIRM_RE.test(text)) {
      this.items.delete(key);
      return { confirm: plan };
    }
    if (CANCEL_RE.test(text)) {
      this.items.delete(key);
      return { cancel: plan };
    }
    return null;
  }
}
