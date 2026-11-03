// Leitura das páginas públicas de busca (Buscapé, KaBuM, AliExpress) e escolha do que é parecido
// com o que pediram. Tudo puro: recebe HTML, devolve ofertas — os testes rodam sem rede.

const BUSCAPE = "https://www.buscape.com.br";

const brlFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** 3522.98 → "R$ 3.522,98" (espaço normal, não o fino do Intl, pra ficar igual no zap e no Discord). */
export function brl(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return brlFormat.format(n).replace(/\s/g, " ");
}

function num(value) {
  const n = typeof value === "string" ? Number(value.replace(/\./g, "").replace(",", ".")) : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function nextData(html) {
  const m = String(html ?? "").match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const cleanTitle = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ───────────────────────── Buscapé ─────────────────────────

/** Busca do Buscapé: ofertas soltas ("offer") e páginas que comparam várias lojas ("product"). */
export function parseBuscapeSearch(html) {
  const hits = nextData(html)?.props?.initialReduxState?.hits?.hits;
  if (!Array.isArray(hits)) return [];
  const out = [];
  for (const h of hits) {
    const price = num(h?.price);
    const title = cleanTitle(h?.name ?? h?.shortName);
    if (!price || !title || !h?.url) continue;
    const kind = h.type === "product" ? "product" : "offer";
    const storeCount = Number(h.storeCount) || 0;
    const merchant = h.merchantName ?? h.bestOffer?.merchantName ?? null;
    out.push({
      key: `buscape:${kind}:${h.sourceId ?? h.objectId}`,
      source: "buscape",
      kind,
      title,
      price,
      store: kind === "product" && storeCount > 1 ? `${storeCount} lojas no Buscapé (melhor: ${merchant ?? "?"})` : merchant ?? "loja no Buscapé",
      url: h.url.startsWith("http") ? h.url : `${BUSCAPE}${h.url.startsWith("/") ? "" : "/"}${h.url.replace(/[?&]_lc=[^&]*/, "")}`,
      productId: kind === "product" ? String(h.sourceId ?? "") : null,
      installments: h.installments?.amount_months ? { months: h.installments.amount_months, value: num(h.installments.price) } : null,
      loweringPct: Number(h.loweringPercentage) || 0
    });
  }
  return out;
}

/**
 * Página de produto do Buscapé: lojas que vendem, o histórico de preço dos últimos ~40 dias que a
 * própria página já traz e a "dica" (se o preço tá bom, a mediana do período).
 */
export function parseBuscapeProduct(html) {
  const st = nextData(html)?.props?.initialReduxState;
  if (!st) return null;
  const productId = String(st.offers?.currentProductID ?? st.products?.product?.product?.id ?? "");
  const list = Array.isArray(st.offers?.offerList) && st.offers.offerList.length ? st.offers.offerList : st.offers?.displayOffers ?? [];
  const sellers = new Map();
  const offers = [];
  for (const o of list) {
    const price = num(o?.price);
    if (o?.merchantId && o?.sellerName) sellers.set(String(o.merchantId), o.sellerName);
    if (!price) continue;
    offers.push({ id: String(o.id ?? ""), title: cleanTitle(o.name), store: o.sellerName ?? "?", price, url: o.id ? `${BUSCAPE}/lead?oid=${o.id}` : null });
  }
  offers.sort((a, b) => a.price - b.price);
  // Mesma loja com várias ofertas (cor, kit): fica a mais barata.
  const byStore = new Set();
  const cheapestPerStore = offers.filter((o) => (byStore.has(o.store) ? false : byStore.add(o.store)));
  const days = st.priceHistory?.priceHistory?.[productId]?.days ?? [];
  const history = days
    .map((d) => ({ date: String(d?.date ?? "").slice(0, 10), price: num(d?.price), store: sellers.get(String(d?.merchantId)) ?? null }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.price);
  const tip = st.priceTip?.[productId]?.priceTip ?? null;
  return {
    productId,
    title: cleanTitle(st.products?.product?.product?.name),
    offers: cheapestPerStore,
    history,
    tip: tip
      ? { verdict: String(tip.description ?? ""), median: num(tip.median_price), from: tip.date_range?.start ?? null, to: tip.date_range?.end ?? null }
      : null
  };
}

/** "REGULAR_PRICE" etc. → texto curto. */
export function describeTip(verdict) {
  const v = String(verdict ?? "").toUpperCase();
  if (/GREAT|EXCELLENT|BEST/.test(v)) return "tá ótimo (bem abaixo do normal)";
  if (/GOOD|LOW/.test(v)) return "tá bom (abaixo do normal)";
  if (/REGULAR|AVERAGE|NORMAL/.test(v)) return "tá normal (perto da média)";
  if (/HIGH|EXPENSIVE|BAD/.test(v)) return "tá caro (acima do normal)";
  return "";
}

// ───────────────────────── KaBuM ─────────────────────────

export function parseKabumSearch(html) {
  let data = nextData(html)?.props?.pageProps?.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const items = data?.catalogServer?.data;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const p of items) {
    if (p?.available === false) continue;
    const full = num(p?.price);
    const pix = num(p?.priceWithDiscount);
    const price = pix && full ? Math.min(pix, full) : pix ?? full;
    const title = cleanTitle(p?.name);
    if (!price || !title || !p?.code) continue;
    const old = num(p?.oldPrice);
    out.push({
      key: `kabum:${p.code}`,
      source: "kabum",
      kind: "offer",
      title,
      price,
      originalPrice: old && old > price ? old : full && full > price ? full : null,
      store: p.sellerName && !/kabum/i.test(p.sellerName) ? `KaBuM! (vendido por ${p.sellerName})` : "KaBuM!",
      url: `https://www.kabum.com.br/produto/${p.code}${p.friendlyName ? `/${p.friendlyName}` : ""}`,
      note: pix && full && pix < full ? "à vista no pix" : null
    });
  }
  return out;
}

// ───────────────────────── AliExpress ─────────────────────────

/** Acha o objeto JSON que começa em `start` (lida com strings e chaves aninhadas). */
function sliceJsonObject(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseAliexpressSearch(html) {
  const text = String(html ?? "");
  const at = text.indexOf('"itemList":{');
  if (at < 0) return [];
  const raw = sliceJsonObject(text, at + '"itemList":'.length);
  let list;
  try {
    list = JSON.parse(raw ?? "null")?.content;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    const id = String(it?.productId ?? "");
    const sale = it?.prices?.salePrice;
    const price = num(sale?.minPrice);
    const title = cleanTitle(it?.title?.displayTitle);
    if (!id || !price || !title || (sale?.currencyCode && sale.currencyCode !== "BRL")) continue;
    const original = num(it?.prices?.originalPrice?.minPrice);
    const sold = String(it?.trade?.tradeDesc ?? "").replace(/\s+/g, " ").trim();
    const fromBrazil = /envio do brasil|enviado do brasil|armaz[eé]m (no )?brasil/i.test(title);
    out.push({
      key: `aliexpress:${id}`,
      source: "aliexpress",
      kind: "offer",
      title,
      price,
      originalPrice: original && original > price ? original : null,
      store: "AliExpress",
      url: `https://pt.aliexpress.com/item/${id}.html`,
      rating: Number(it?.evaluation?.starRating) || null,
      sold: sold || null,
      // Preço da busca não inclui imposto de importação quando vem de fora.
      note: fromBrazil ? "envio do Brasil" : "pode ter imposto de importação"
    });
  }
  return out;
}

// ───────────────────────── o que é parecido ─────────────────────────

const STOP = new Set(["de", "da", "do", "das", "dos", "para", "pra", "com", "sem", "e", "a", "o", "em", "na", "no", "um", "uma", "the", "for", "with"]);
// Palavras de categoria: contam, mas menos que marca/modelo.
const GENERIC = new Set(["impressora", "3d", "resina", "celular", "smartphone", "notebook", "placa", "video", "monitor", "fone", "teclado", "mouse", "cadeira", "tv", "smart", "novo", "nova", "original", "kit"]);
const SYNONYMS = { saturno: "saturn", marte: "mars", jupiter: "jupiter", ultra: "ultra", pol: "polegadas" };
// Coisas que são peça/acessório de um produto (só contam se a pessoa pediu isso).
// (Peça bem mais barata que escapar daqui cai no corte de preço em `pickRelevant`.)
const ACCESSORY_RE = /\b(filmes?|fep|pfa|acf|peliculas?|protetor(es)?|tanques?|plataforma|build plate|placas? de (construcao|impressao)|suportes?|pecas?|reposicao|capas?|capinha|adaptador|pcs|bico|correia|ventoinha)\b/;

export function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokens(s) {
  return normalizeText(s)
    .split(" ")
    .filter((t) => t && !STOP.has(t))
    .map((t) => SYNONYMS[t] ?? t);
}

// Palavra de versão que muda o produto ("iPhone 16" ≠ "iPhone 16 Plus").
const VARIANT = new Set(["pro", "plus", "max", "mini", "lite", "ultra", "fe", "air", "slim", "neo"]);

/**
 * Quanto do que pediram aparece no título (0–1). Marca/modelo pesam o dobro da categoria; versão
 * que não pediram (pro, plus, ultra…) desconta.
 */
export function matchScore(query, title) {
  const q = [...new Set(tokens(query))];
  if (!q.length) return 0;
  const t = new Set(tokens(title));
  let total = 0;
  let got = 0;
  for (const tok of q) {
    const w = GENERIC.has(tok) ? 0.5 : 1;
    total += w;
    if (t.has(tok)) got += w;
  }
  const qs = new Set(q);
  const extraVariants = [...t].filter((tok) => VARIANT.has(tok) && !qs.has(tok)).length;
  return total ? Math.max(0, got / total - 0.2 * extraVariants) : 0;
}

export function isAccessory(query, title) {
  return ACCESSORY_RE.test(normalizeText(title)) && !ACCESSORY_RE.test(normalizeText(query));
}

/** Versões da busca: a frase inteira e só marca/modelo (sites erram com frase longa). */
export function queryVariants(query) {
  const full = normalizeText(query);
  const core = tokens(query).filter((t) => !GENERIC.has(t)).join(" ");
  return [...new Set([full, core].filter((q) => q && q.split(" ").length >= 1))];
}

const USED_RE = /\b(usad[oa]s?|seminov[oa]s?|recondicionad[oa]s?|vitrine|open ?box|refurbished)\b/;

/**
 * Do que veio das buscas, fica o que é o produto (não peça), sem repetidos. Ordem: novo antes de
 * usado, mais parecido primeiro, página que compara lojas (tem histórico) antes de oferta solta, e
 * mais barato dentro do mesmo nível.
 */
export function pickRelevant(query, offers, { minScore = 0.7, max = 12 } = {}) {
  const seen = new Set();
  const wantsUsed = USED_RE.test(normalizeText(query));
  let list = [];
  for (const o of offers) {
    if (!o?.key || seen.has(o.key)) continue;
    seen.add(o.key);
    const score = matchScore(query, o.title);
    if (score < minScore || isAccessory(query, o.title)) continue;
    const used = !wantsUsed && USED_RE.test(normalizeText(o.title));
    list.push({ ...o, score: Math.round(score * 100) / 100, ...(used ? { used: true, note: ["usado", o.note].filter(Boolean).join(" · ") } : {}) });
  }
  // Muito mais barato que o resto costuma ser peça/anúncio enganoso.
  if (list.length >= 3) {
    const prices = list.map((o) => o.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    list = list.filter((o) => o.price >= median * 0.35);
  }
  const bucket = (o) => Math.round(o.score * 10);
  list.sort(
    (a, b) =>
      Number(Boolean(a.used)) - Number(Boolean(b.used)) ||
      bucket(b) - bucket(a) ||
      Number(b.kind === "product") - Number(a.kind === "product") ||
      a.price - b.price
  );
  return list.slice(0, max);
}
