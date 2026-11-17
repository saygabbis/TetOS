import { createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Cliente do Convenus (o conversor da Gabbis: convert.saygabbis.cloud, mesma VPS na porta 5180).
 * Ele já tem yt-dlp atualizado, cookies do YouTube, WARP e PO token — baixa de YouTube, YouTube
 * Music, Spotify, Deezer, Apple Music, X, Instagram, TikTok, Bluesky, Facebook, SoundCloud, Twitch,
 * Vimeo, Pinterest, Tumblr… e converte arquivos (vídeo, áudio, imagem, PDF, docx, planilha…).
 *
 * Fluxo de link: POST /api/info → POST /api/jobs → GET /api/jobs/:id até "done" → /file.
 * Fluxo de arquivo: POST /api/upload → POST /api/jobs { upload, to } → mesma espera.
 * Imagem de post (foto do Insta/X): GET /api/media?u=… (o servidor só busca de CDNs conhecidas).
 */

const DEVICE_COOKIE = "cv_dev";
const DONE = new Set(["done"]);
const FAILED = new Set(["error", "canceled", "failed"]);

export class ConvenusError extends Error {
  constructor(message, { status = 0, unreachable = false } = {}) {
    super(message);
    this.name = "ConvenusError";
    this.status = status;
    this.unreachable = unreachable;
  }
}

export class ConvenusClient {
  constructor({
    baseUrls = ["http://127.0.0.1:5180", "https://convert.saygabbis.cloud"],
    outputDir = "./data/media/derived",
    jobTimeoutMs = 15 * 60_000,
    pollMs = 1500,
    requestTimeoutMs = 90_000,
    fetchImpl = null,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = {}) {
    this.baseUrls = (Array.isArray(baseUrls) ? baseUrls : String(baseUrls ?? "").split(","))
      .map((u) => String(u ?? "").trim().replace(/\/$/, ""))
      .filter(Boolean);
    this.outputDir = outputDir;
    this.jobTimeoutMs = jobTimeoutMs;
    this.pollMs = pollMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.sleep = sleep;
    /** O Convenus amarra cada tarefa a um "aparelho" (cookie): usamos um fixo por processo. */
    this.device = randomBytes(18).toString("base64url");
    /** Endereço que respondeu por último (local primeiro; o público é a reserva). */
    this.activeBase = null;
  }

  isConfigured() {
    return this.baseUrls.length > 0;
  }

  _headers(extra = {}) {
    return { cookie: `${DEVICE_COOKIE}=${this.device}`, "user-agent": "TetOS/1.0", ...extra };
  }

  async _request(path, { method = "GET", json, body, headers = {}, timeoutMs = this.requestTimeoutMs, raw = false } = {}) {
    const bases = this.activeBase ? [this.activeBase, ...this.baseUrls.filter((b) => b !== this.activeBase)] : this.baseUrls;
    let lastError = null;
    for (const base of bases) {
      let response;
      try {
        response = await this.fetch(`${base}${path}`, {
          method,
          headers: this._headers({ ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers }),
          body: json !== undefined ? JSON.stringify(json) : body,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        // Não respondeu (local fora do ar, rede): tenta o próximo endereço.
        lastError = new ConvenusError(`conversor fora do ar (${error?.message ?? error})`, { unreachable: true });
        continue;
      }
      this.activeBase = base;
      if (raw) {
        if (!response.ok) throw new ConvenusError(await errorText(response), { status: response.status });
        return response;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new ConvenusError(data?.error || `HTTP ${response.status}`, { status: response.status });
      return data;
    }
    throw lastError ?? new ConvenusError("conversor não configurado", { unreachable: true });
  }

  async health() {
    try {
      const data = await this._request("/api/status", { timeoutMs: 6000 });
      return { ok: data?.ok !== false, youtube: data?.youtube !== false };
    } catch {
      return { ok: false, youtube: false };
    }
  }

  /** Metadados do link: título, duração, itens (vídeo/áudio/imagem), qualidades, legendas. */
  async info(url) {
    return this._request("/api/info", { method: "POST", json: { url, full: true } });
  }

  async createJob(payload) {
    return this._request("/api/jobs", { method: "POST", json: payload });
  }

  async waitJob(id, { onProgress = null } = {}) {
    const started = Date.now();
    let lastPhase = "";
    for (;;) {
      const job = await this._request(`/api/jobs/${id}`, { timeoutMs: 20_000 });
      if (DONE.has(job.status)) return job;
      if (FAILED.has(job.status)) throw new ConvenusError(job.error || "a conversão falhou");
      const phase = `${job.phase ?? ""}`;
      if (onProgress && phase && phase !== lastPhase) {
        lastPhase = phase;
        try {
          onProgress(job);
        } catch {
          /* aviso de progresso é opcional */
        }
      }
      if (Date.now() - started > this.jobTimeoutMs) {
        void this._request(`/api/jobs/${id}`, { method: "DELETE" }).catch(() => {});
        throw new ConvenusError("demorou demais (passou de 15 min)");
      }
      await this.sleep(this.pollMs);
    }
  }

  async downloadJobFile(job, { dir = this.outputDir } = {}) {
    mkdirSync(dir, { recursive: true });
    const response = await this._request(`/api/jobs/${job.id}/file`, { raw: true, timeoutMs: 30 * 60_000 });
    const name = filenameFrom(response.headers.get("content-disposition")) || job.filename || `${job.id}.${job.kind || "bin"}`;
    const dest = join(dir, `cv-${job.id}-${safeFileName(name)}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
    return { path: dest, fileName: name, size: statSync(dest).size, title: job.title || null };
  }

  /** Imagem/vídeo direto de um post (CDN conhecida) passando pelo servidor. */
  async downloadMedia(mediaUrl, { name = "midia", dir = this.outputDir } = {}) {
    mkdirSync(dir, { recursive: true });
    const q = `/api/media?u=${encodeURIComponent(mediaUrl)}&name=${encodeURIComponent(name)}`;
    const response = await this._request(q, { raw: true, timeoutMs: 10 * 60_000 });
    const fileName = filenameFrom(response.headers.get("content-disposition")) || `${name}${extFromType(response.headers.get("content-type"))}`;
    const dest = join(dir, `cv-${randomBytes(5).toString("hex")}-${safeFileName(fileName)}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
    return { path: dest, fileName, size: statSync(dest).size };
  }

  /**
   * Baixa um link. kind: mp4 | mp3 | wav | srt | post (o que o post tiver: vídeo e/ou fotos).
   * quality: full | mid | low (ou número: altura do vídeo / kbps do mp3).
   * Devolve { title, platform, files: [{ path, fileName, size, kind }] }.
   */
  async downloadLink(url, { kind = "post", quality = "full", subsLang = null, maxItems = 10, onProgress = null } = {}) {
    const info = await this.info(url);
    const items = Array.isArray(info?.items) ? info.items : [];
    if (!items.length) throw new ConvenusError("não achei nada pra baixar nesse link");
    const title = info.title || "arquivo";
    const files = [];
    const wantAudio = kind === "mp3" || kind === "wav";

    if (kind === "srt") {
      const idx = items.findIndex((it) => it.subs?.length);
      const item = items[idx];
      if (!item) throw new ConvenusError("esse vídeo não tem legenda disponível");
      const sub = pickSub(item.subs, subsLang);
      const job = await this.createJob({ url, kind: "srt", item: idx, subs: { lang: sub.lang }, title });
      const done = await this.waitJob(job.id, { onProgress });
      files.push({ ...(await this.downloadJobFile(done)), kind: "document", subLang: sub.lang, subName: sub.name, auto: sub.auto });
      return { title, platform: info.platform || "", files };
    }

    const targets = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => (wantAudio ? item.kind !== "image" : kind === "mp4" ? item.kind === "video" : true))
      .slice(0, maxItems);
    if (!targets.length) {
      throw new ConvenusError(wantAudio ? "esse link não tem áudio/vídeo" : kind === "mp4" ? "esse post não tem vídeo (só foto?)" : "não achei mídia nesse link");
    }

    for (const { item, index } of targets) {
      if (item.kind === "image") {
        if (!item.url) continue;
        const media = await this.downloadMedia(item.url, { name: `${safeFileName(title).slice(0, 40)}-${index + 1}` });
        files.push({ ...media, kind: "image" });
        continue;
      }
      // Vídeo que já vem pronto em MP4 (não precisa converter): só baixa.
      if (!wantAudio && !item.native && !item.hls && item.url) {
        const media = await this.downloadMedia(item.url, { name: safeFileName(title).slice(0, 60) });
        files.push({ ...media, kind: "video" });
        continue;
      }
      const jobKind = wantAudio ? kind : item.kind === "audio" ? "mp3" : "mp4";
      const payload = { url, kind: jobKind, item: index, title };
      if (jobKind === "mp4") payload.quality = pickHeight(item.heights, quality);
      if (jobKind === "mp3") payload.quality = pickBitrate(quality);
      const job = await this.createJob(payload);
      const done = await this.waitJob(job.id, { onProgress });
      const file = await this.downloadJobFile(done);
      files.push({ ...file, kind: jobKind === "mp4" ? "video" : "audio" });
    }
    if (!files.length) throw new ConvenusError("não consegui baixar nada desse link");
    return { title, platform: info.platform || "", files };
  }

  /** Capa/miniatura de qualquer link (a maior que tiver). */
  async downloadThumbnail(url) {
    const info = await this.info(url);
    const thumbUrl = info?.thumbs?.[0]?.url || info?.thumbnail || info?.items?.[0]?.thumb;
    if (!thumbUrl) throw new ConvenusError("esse link não tem capa");
    const media = await this.downloadMedia(thumbUrl, { name: `capa-${safeFileName(info.title || "video").slice(0, 40)}` });
    return { title: info.title || null, platform: info.platform || "", files: [{ ...media, kind: "image" }] };
  }

  /** Sobe um arquivo local; devolve { id, kind, ext, desc, targets: [{ to, label, group }] }. */
  async upload(filePath, { name = null } = {}) {
    const size = statSync(filePath).size;
    if (!size) throw new ConvenusError("arquivo vazio");
    if (size > 512 * 1024 * 1024) throw new ConvenusError("arquivo grande demais pra converter por aqui (máx. 512 MB)");
    // Buffer (não stream): o fetch manda o content-length certo, que o Convenus exige.
    return this._request("/api/upload", {
      method: "POST",
      body: readFileSync(filePath),
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeHeader(name || basename(filePath))
      },
      timeoutMs: 30 * 60_000
    });
  }

  /** Converte um arquivo local pra `to` (mp3, pdf, png, gif…). */
  async convertFile(filePath, to, { name = null, onProgress = null } = {}) {
    const up = await this.upload(filePath, { name });
    const target = String(to ?? "").toLowerCase().replace(/^\./, "");
    const ok = (up.targets ?? []).some((t) => t.to === target);
    if (!ok) {
      const options = (up.targets ?? []).map((t) => t.to).join(", ");
      throw new ConvenusError(`${up.desc || "esse arquivo"} não vira ${target}. Dá pra: ${options || "nada"}`, { status: 400 });
    }
    const job = await this.createJob({ upload: up.id, to: target });
    const done = await this.waitJob(job.id, { onProgress });
    const file = await this.downloadJobFile(done);
    return { ...file, from: up.desc || up.ext, to: target };
  }
}

function pickSub(subs = [], lang = null) {
  const want = String(lang ?? "").toLowerCase();
  const list = subs ?? [];
  return (
    (want && list.find((s) => s.lang?.toLowerCase() === want)) ||
    (want && list.find((s) => s.lang?.toLowerCase().startsWith(want))) ||
    list.find((s) => /^pt/i.test(s.lang) && !s.auto) ||
    list.find((s) => /^pt/i.test(s.lang)) ||
    list.find((s) => !s.auto) ||
    list[0]
  );
}

const HEIGHT_FOR = { full: 1080, max: 1080, mid: 720, low: 360, min: 360 };

/** Altura do vídeo: a maior até o alvo (full 1080, mid 720, low 360); 0 = o servidor escolhe. */
export function pickHeight(heights = [], quality = "full") {
  const target = Number.isFinite(Number(quality)) && Number(quality) >= 100 ? Number(quality) : HEIGHT_FOR[quality] ?? 1080;
  const list = (heights ?? []).map(Number).filter((h) => Number.isFinite(h) && h >= 100).sort((a, b) => b - a);
  if (!list.length) return 0;
  return list.find((h) => h <= target) ?? list[list.length - 1];
}

export function pickBitrate(quality = "full") {
  const q = String(quality ?? "");
  if (["128", "192", "256", "320"].includes(q)) return q;
  return q === "low" || q === "min" ? "128" : q === "mid" ? "192" : "320";
}

function filenameFrom(header = "") {
  const h = String(header ?? "");
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* cai pro simples */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(h);
  return plain ? plain[1] : "";
}

function safeFileName(name = "") {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length).replace(/[^\p{L}\p{N} ._-]+/gu, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "arquivo";
  return `${stem}${ext.replace(/[^.\w]/g, "")}`;
}

function encodeHeader(value) {
  return String(value ?? "").replace(/[^\x20-\x7e]/g, "_").slice(0, 180);
}

function extFromType(type = "") {
  const t = String(type ?? "").split(";")[0].trim();
  return { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "audio/mpeg": ".mp3" }[t] ?? "";
}

async function errorText(response) {
  try {
    const data = await response.json();
    return data?.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
