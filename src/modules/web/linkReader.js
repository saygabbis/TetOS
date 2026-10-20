import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveYtDlpBinary } from "../../core/media/ytDlpRunner.js";
import { detectPlatform } from "../../core/media/urlPlatformDetect.js";

/**
 * "Abre" os links que mandam pra Teto: título, texto, legenda do vídeo, foto do post (via visão)…
 * Vira um bloco [LINK] no prompt para ela comentar como quem viu — em vez de só baixar ou ignorar.
 */

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT = 2200;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function extractLinks(text = "") {
  const found = String(text ?? "").match(URL_RE) ?? [];
  return [...new Set(found.map((u) => u.replace(/[),.;!?…]+$/g, "").replace(/[)\]}>]+$/g, "")))];
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };

export function decodeEntities(s = "") {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, k) => ENTITIES[k] ?? ENTITIES[k.toLowerCase()] ?? m);
}

const clean = (s, max = MAX_TEXT) => {
  const t = decodeEntities(String(s ?? "")).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}…` : t;
};

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return tag.match(/content=["']([^"']*)["']/i)?.[1] ?? null;
}

/** Tag HTML inteira, mesmo com ">" dentro de atributo entre aspas (ex.: data-mw da Wikipédia). */
const TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const stripTags = (h) => String(h ?? "").replace(TAG_RE, " ");

/** Texto principal da página: parágrafos de <article>/<main>/<body>, sem script, menu e rodapé. */
export function readableText(html = "") {
  const h = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template|table)\b[\s\S]*?<\/\1>/gi, " ");
  const main = h.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? h.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? h.match(/<body\b[\s\S]*<\/body>/i)?.[0] ?? h;
  const paragraphs = [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => clean(stripTags(m[1]), 1000))
    .filter((p) => p.length >= 40);
  const tidy = (t) => t.replace(/\[\s*\d+\s*\]/g, "").replace(/\s+([,.;:)])/g, "$1").replace(/\(\s+/g, "(");
  if (paragraphs.join(" ").length >= 200) return clean(tidy(paragraphs.join(" ")));
  return clean(stripTags(main.replace(/<\/(p|div|h\d|li|br|tr)>/gi, ". ")).replace(/(\.\s*){2,}/g, ". "));
}

async function fetchText(url, { ua = BROWSER_UA, timeoutMs = 8000, accept = "text/html,application/json;q=0.9,*/*;q=0.5" } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": ua, accept, "accept-language": "pt-BR,pt;q=0.9,en;q=0.7" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs)
  });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (/^(image|video|audio)\//i.test(type) || /pdf|octet-stream|zip/i.test(type)) {
    return { type, finalUrl: res.url, body: null, response: res };
  }
  const reader = res.body?.getReader?.();
  if (!reader) return { type, finalUrl: res.url, body: await res.text() };
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > MAX_HTML_BYTES) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  return { type, finalUrl: res.url, body: Buffer.concat(chunks).toString("utf8") };
}

const fetchJson = async (url, opts) => JSON.parse((await fetchText(url, { ...opts, accept: "application/json" })).body ?? "null");

function ytDlpJson(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resolveYtDlpBinary(), ["--dump-json", "--skip-download", "--no-warnings", "--no-playlist", url], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp demorou"));
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split("\n").pop() || `yt-dlp ${code}`));
      try {
        resolvePromise(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Legenda (manual > automática; pt > en) em texto corrido. */
async function youtubeCaptionText(info) {
  const pick = (tracks = {}) => {
    for (const lang of ["pt-BR", "pt", "pt-PT", "en", "en-US", "en-orig"]) {
      const f = (tracks[lang] ?? []).find((t) => t.ext === "json3");
      if (f?.url) return f.url;
    }
    return null;
  };
  const url = pick(info.subtitles) ?? pick(info.automatic_captions);
  if (!url) return null;
  try {
    const json = await fetchJson(url, { timeoutMs: 6000 });
    const text = (json?.events ?? []).map((e) => (e.segs ?? []).map((s) => s.utf8 ?? "").join("")).join(" ");
    return clean(text.replace(/\[(música|music|aplausos|applause)\]/gi, " "), 1800) || null;
  } catch {
    return null;
  }
}

const fmtCount = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, "")} bi`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")} mi`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")} mil`;
  return String(v);
};

const fmtDuration = (sec) => {
  const s = Math.round(Number(sec));
  if (!Number.isFinite(s) || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};

export class LinkReader {
  constructor({ describeImageFile = null, timeoutMs = 12_000, cacheSize = 200 } = {}) {
    this.describeImageFile = describeImageFile;
    this.timeoutMs = timeoutMs;
    this.cacheSize = cacheSize;
    this.cache = new Map();
  }

  /** Lê até `max` links do texto dentro do orçamento de tempo; links que não abrem ficam como { failed: true }. */
  async readAll(text, { max = 2, budgetMs = this.timeoutMs } = {}) {
    const urls = extractLinks(text).slice(0, max);
    if (!urls.length) return [];
    const settled = await Promise.all(
      urls.map((url) =>
        Promise.race([
          this.read(url).catch(() => ({ url, failed: true })),
          new Promise((r) => setTimeout(() => r({ url, failed: true, slow: true }), budgetMs))
        ])
      )
    );
    return settled.filter(Boolean);
  }

  async read(url) {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await this.readUncached(url);
    if (value) {
      this.cache.set(url, { at: Date.now(), value });
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  async readUncached(url) {
    const platform = /open\.spotify\.com/i.test(url) ? "spotify" : detectPlatform(url);
    try {
      if (platform === "youtube") return await this.readYoutube(url);
      if (platform === "twitter") return await this.readTweet(url);
      if (platform === "tiktok") return await this.readTiktok(url);
      if (platform === "instagram") return await this.readInstagram(url);
      if (platform === "spotify") return await this.readSpotify(url);
    } catch {
      /* cai na leitura genérica */
    }
    return this.readPage(url);
  }

  async describeImageUrl(imageUrl) {
    if (!this.describeImageFile || !imageUrl) return null;
    const dir = mkdtempSync(join(tmpdir(), "tetos-link-"));
    try {
      const res = await fetch(imageUrl, { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const file = join(dir, "img.jpg");
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      const desc = await this.describeImageFile(file);
      return desc ? clean(desc, 500) : null;
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async readYoutube(url) {
    try {
      const info = await ytDlpJson(url);
      const transcript = await youtubeCaptionText(info);
      return {
        url,
        site: "YouTube",
        kind: info.duration && info.duration <= 70 && /shorts/i.test(url) ? "short" : "vídeo",
        title: clean(info.title, 200),
        author: info.uploader ?? info.channel ?? null,
        details: [
          fmtDuration(info.duration) && `duração ${fmtDuration(info.duration)}`,
          fmtCount(info.view_count) && `${fmtCount(info.view_count)} views`,
          info.upload_date && `postado em ${info.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1")}`
        ].filter(Boolean),
        text: clean(info.description, 500) || null,
        transcript
      };
    } catch {
      const o = await fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      return { url, site: "YouTube", kind: "vídeo", title: clean(o?.title, 200), author: o?.author_name ?? null };
    }
  }

  async readTweet(url) {
    const m = url.match(/(?:twitter\.com|x\.com)\/([^/?#]+)\/status(?:es)?\/(\d+)/i);
    if (!m) throw new Error("não é post");
    const data = await fetchJson(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`);
    const t = data?.tweet;
    if (!t) throw new Error("post não encontrado");
    const photos = t.media?.photos ?? [];
    const videos = t.media?.videos ?? [];
    const imageDescription = await this.describeImageUrl(photos[0]?.url ?? videos[0]?.thumbnail_url ?? null);
    return {
      url,
      site: "X (Twitter)",
      kind: "post",
      author: t.author ? `${t.author.name} (@${t.author.screen_name})` : null,
      text: clean(t.text, 800) || null,
      details: [
        photos.length && `${photos.length} foto(s)`,
        videos.length && `vídeo${videos[0]?.duration ? ` de ${fmtDuration(videos[0].duration)}` : ""}`,
        fmtCount(t.likes) && `${fmtCount(t.likes)} curtidas`,
        fmtCount(t.retweets) && `${fmtCount(t.retweets)} reposts`
      ].filter(Boolean),
      quote: t.quote ? clean(`${t.quote.author?.name ?? ""}: ${t.quote.text ?? ""}`, 300) : null,
      imageDescription
    };
  }

  async readTiktok(url) {
    const info = await ytDlpJson(url, { timeoutMs: 12000 });
    return {
      url,
      site: "TikTok",
      kind: "vídeo",
      author: info.uploader ?? info.creator ?? null,
      text: clean(info.description ?? info.title, 500) || null,
      details: [fmtDuration(info.duration) && `${fmtDuration(info.duration)}`, fmtCount(info.view_count) && `${fmtCount(info.view_count)} views`].filter(Boolean),
      imageDescription: await this.describeImageUrl(info.thumbnail)
    };
  }

  async readInstagram(url) {
    const m = url.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([\w-]+)/i);
    if (m) {
      const { body } = await fetchText(`https://www.instagram.com/${m[1] === "reels" ? "reel" : m[1]}/${m[2]}/embed/captioned/`);
      const html = body ?? "";
      const caption = html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
      const author = html.match(/class="UsernameText"[^>]*>([^<]+)</i)?.[1] ?? html.match(/class="Username"[^>]*>(?:<[^>]+>)*([^<]+)/i)?.[1];
      const image = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i)?.[1];
      if (caption || image) {
        return {
          url,
          site: "Instagram",
          kind: /reel|tv/i.test(m[1]) ? "reels" : "post",
          author: author ? clean(author, 60) : null,
          text: caption ? clean(stripTags(caption.replace(/<a[^>]*class="CaptionUsername"[\s\S]*?<\/a>/i, "").replace(/<br\s*\/?>/gi, " ")), 700) : null,
          imageDescription: await this.describeImageUrl(image ? decodeEntities(image) : null)
        };
      }
    }
    const info = await ytDlpJson(url, { timeoutMs: 12000 });
    return {
      url,
      site: "Instagram",
      kind: "post",
      author: info.uploader ?? info.channel ?? null,
      text: clean(info.description ?? info.title, 700) || null,
      imageDescription: await this.describeImageUrl(info.thumbnail)
    };
  }

  async readSpotify(url) {
    const o = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    const page = await fetchText(url).catch(() => null);
    const desc = page?.body ? metaContent(page.body, "og:description") : null;
    return { url, site: "Spotify", kind: /\/track\//.test(url) ? "música" : "link", title: clean(o?.title, 200), text: desc ? clean(desc, 300) : null };
  }

  async readPage(url) {
    const page = await fetchText(url);
    if (!page.body) {
      if (/^image\//i.test(page.type)) {
        return { url, site: new URL(page.finalUrl || url).hostname, kind: "imagem", imageDescription: await this.describeImageUrl(url) };
      }
      return { url, site: new URL(page.finalUrl || url).hostname, kind: page.type.split(";")[0] || "arquivo" };
    }
    const html = page.body;
    const title = metaContent(html, "og:title") ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const description = metaContent(html, "og:description") ?? metaContent(html, "description");
    const site = metaContent(html, "og:site_name") ?? new URL(page.finalUrl || url).hostname.replace(/^www\./, "");
    const body = readableText(html);
    return {
      url,
      site: clean(site, 60),
      kind: "página",
      title: clean(title, 200) || null,
      text: clean(description, 400) || null,
      body: body && body.length > 200 ? body : null
    };
  }
}

/** Bloco do prompt com o que ela "viu" em cada link. */
export function formatLinksForPrompt(items = []) {
  const ok = items.filter((i) => i && !i.failed);
  const failed = items.filter((i) => i?.failed);
  const lines = [];
  for (const i of ok) {
    lines.push(`• ${i.site}${i.kind ? ` (${i.kind})` : ""}${i.author ? ` de ${i.author}` : ""}${i.title ? `: «${i.title}»` : ""}`);
    if (i.details?.length) lines.push(`  ${i.details.join(" · ")}`);
    if (i.text) lines.push(`  Texto: ${i.text}`);
    if (i.quote) lines.push(`  Citando: ${i.quote}`);
    if (i.imageDescription) lines.push(`  Imagem: ${i.imageDescription}`);
    if (i.transcript) lines.push(`  O que falam no vídeo (legenda): ${i.transcript}`);
    if (i.body) lines.push(`  Conteúdo: ${i.body}`);
  }
  if (!lines.length && !failed.length) return null;
  return [
    "[LINK — você abriu e viu]",
    ...lines,
    ...(failed.length ? [`(${failed.length === 1 ? "um link não abriu" : "alguns links não abriram"} agora — se for o caso, diga natural que não carregou, sem inventar o conteúdo)`] : []),
    "Comente como amiga que abriu o link: reaja ao conteúdo (o que achou, o que chamou atenção), sem resumir tudo nem listar dados. Não diga 'acessei o link' nem fale de legenda/metadados. Só baixe/mande arquivo se pedirem."
  ].join("\n");
}
