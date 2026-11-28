/**
 * GIF de teclado (GIPHY / Tenor) pra Teto mandar de vez em quando — tipo os gifs que a gente manda
 * pelo teclado do celular. Precisa de chave: TETOS_GIPHY_API_KEY e/ou TETOS_TENOR_API_KEY.
 * Retorna um MP4 (o zap toca como GIF com gifPlayback).
 */
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 6 * 1024 * 1024;
const recentByQuery = new Map();

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`gif search HTTP ${res.status}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`gif download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("gif grande demais");
  return buf;
}

async function giphyCandidates(query, key, lang) {
  const u = new URL("https://api.giphy.com/v1/gifs/search");
  u.search = new URLSearchParams({ api_key: key, q: query, limit: "12", rating: "pg-13", lang }).toString();
  const data = await fetchJson(u);
  return (data?.data ?? [])
    .map((g) => ({ id: `giphy:${g.id}`, mp4: g.images?.fixed_height?.mp4 || g.images?.original?.mp4, url: g.url, title: g.title }))
    .filter((c) => c.mp4);
}

async function tenorCandidates(query, key, lang) {
  const u = new URL("https://tenor.googleapis.com/v2/search");
  u.search = new URLSearchParams({
    key,
    q: query,
    limit: "12",
    contentfilter: "medium",
    media_filter: "mp4,tinymp4",
    locale: lang === "pt" ? "pt_BR" : "en_US",
    client_key: "tetos"
  }).toString();
  const data = await fetchJson(u);
  return (data?.results ?? [])
    .map((r) => ({ id: `tenor:${r.id}`, mp4: r.media_formats?.mp4?.url || r.media_formats?.tinymp4?.url, url: r.itemurl, title: r.content_description }))
    .filter((c) => c.mp4);
}

export function gifSearchEnabled(env = process.env) {
  return Boolean(String(env.TETOS_GIPHY_API_KEY ?? "").trim() || String(env.TETOS_TENOR_API_KEY ?? "").trim());
}

/**
 * Procura um GIF e baixa. Evita repetir o mesmo GIF pra mesma busca.
 * @returns {Promise<{ buffer: Buffer, id: string, url?: string, title?: string } | null>}
 */
export async function findGif(query, { env = process.env, lang = "pt" } = {}) {
  const q = String(query ?? "").trim().slice(0, 80);
  if (!q) return null;
  const giphyKey = String(env.TETOS_GIPHY_API_KEY ?? "").trim();
  const tenorKey = String(env.TETOS_TENOR_API_KEY ?? "").trim();
  const sources = [
    giphyKey ? () => giphyCandidates(q, giphyKey, lang) : null,
    tenorKey ? () => tenorCandidates(q, tenorKey, lang) : null
  ].filter(Boolean);
  const seen = recentByQuery.get(q.toLowerCase()) ?? new Set();
  for (const source of sources) {
    let list = [];
    try {
      list = await source();
    } catch {
      continue;
    }
    // Pega um dos primeiros (mais relevantes), variando, sem repetir.
    const fresh = list.slice(0, 8).filter((c) => !seen.has(c.id));
    const pool = fresh.length ? fresh : list.slice(0, 8);
    if (!pool.length) continue;
    const pick = pool[Math.floor(Math.random() * Math.min(pool.length, 5))];
    try {
      const buffer = await fetchBuffer(pick.mp4);
      seen.add(pick.id);
      if (seen.size > 20) seen.delete(seen.values().next().value);
      recentByQuery.set(q.toLowerCase(), seen);
      return { buffer, id: pick.id, url: pick.url, title: pick.title };
    } catch {
      /* tenta a próxima fonte */
    }
  }
  return null;
}
