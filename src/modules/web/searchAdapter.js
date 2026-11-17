const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

const stripTags = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** O buscador devolve um redirecionador (//duckduckgo.com/l/?uddg=…): extrai o link de verdade. */
export function realResultUrl(href = "") {
  const h = decodeEntities(href);
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return h;
    }
  }
  return h.startsWith("//") ? `https:${h}` : h;
}

/** Resultados do HTML do buscador: título, link real e o trecho de texto (snippet). */
export function parseSearchHtml(html = "", max = 5) {
  const out = [];
  const blocks = String(html).split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const a = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    const url = realResultUrl(a[1]);
    const title = stripTags(a[2]);
    if (!url || !title || /duckduckgo\.com\/y\.js|ad_provider/i.test(url)) continue;
    out.push({ url, title, snippet: snippet ? stripTags(snippet[1]).slice(0, 320) : "" });
    if (out.length >= max) break;
  }
  if (out.length) return out;
  // HTML num formato diferente: pelo menos os títulos/links.
  return [...String(html).matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gsi)]
    .slice(0, max)
    .map((m) => ({ url: realResultUrl(m[1]), title: stripTags(m[2]), snippet: "" }))
    .filter((r) => r.url && r.title);
}

export class SearchAdapter {
  /**
   * backend: duckduckgo (grátis) | openai (web_search da OpenAI, pago) | auto (grátis primeiro:
   * DuckDuckGo e Wikipédia; OpenAI só se nada grátis achou e a busca puder pagar).
   * paid=false: adaptador das tarefas de fundo (mente, música) — nunca usa a busca paga.
   * Resultado fica em cache por algumas horas (mesma pergunta não paga duas vezes).
   */
  constructor({ timeoutMs = 12000, maxResults = 5, backend = "duckduckgo", openai = null, paid = true, cacheTtlMs = 6 * 3_600_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResults = maxResults;
    this.openai = openai?.webSearch && paid ? openai : null;
    this.backend = this.openai && ["openai", "auto"].includes(backend) ? backend : "free";
    this.cacheTtlMs = cacheTtlMs;
    /** @type {Map<string, { at: number, results: any[] }>} */
    this.cache = new Map();
  }

  /** Mesmo motor, mas só com as fontes grátis (pra mente/rotinas de fundo). */
  freeOnly() {
    const free = new SearchAdapter({ timeoutMs: this.timeoutMs, maxResults: this.maxResults, backend: "free", paid: false, cacheTtlMs: this.cacheTtlMs });
    free.cache = this.cache;
    return free;
  }

  async search(query) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const key = q.toLowerCase().replace(/\s+/g, " ");
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.results;
    const results = await this._search(q);
    if (results.length) {
      this.cache.set(key, { at: Date.now(), results });
      if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    }
    return results;
  }

  async _search(q) {
    if (this.backend === "openai") return this.searchOpenAI(q);
    const results = await this.searchFree(q);
    if (results.length || this.backend !== "auto") return results;
    return this.searchOpenAI(q);
  }

  /** DuckDuckGo (bloqueia IP de servidor às vezes) e, se não vier nada, Wikipédia. */
  async searchFree(q) {
    try {
      const results = await this.searchDuckDuckGo(q);
      if (results.length) return results;
    } catch {
      /* cai pra Wikipédia */
    }
    try {
      return await this.searchWikipedia(q);
    } catch {
      return [];
    }
  }

  async searchWikipedia(query, { lang = "pt" } = {}) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${this.maxResults}&srsearch=${encodeURIComponent(q)}`;
      const response = await fetch(url, { headers: { "user-agent": "TetOS/1.0 (chat bot)" }, signal: controller.signal });
      if (!response.ok) throw new Error(`wikipedia ${response.status}`);
      const data = await response.json();
      return (data?.query?.search ?? []).map((r) => ({
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
        title: `${r.title} (Wikipédia)`,
        snippet: decodeEntities(String(r.snippet ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
      }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async searchOpenAI(query) {
    const q = String(query ?? "").trim();
    if (!q || !this.openai) return [];
    const { text, results } = await this.openai.webSearch(q, { maxResults: this.maxResults });
    if (results.length) return results;
    return text ? [{ url: "https://openai.com", title: `Resumo da busca: ${q}`, snippet: text.slice(0, 600) }] : [];
  }

  async searchDuckDuckGo(query) {
    try {
      return await this.searchOnce(query);
    } catch (error) {
      // O buscador às vezes devolve 5xx/timeout por anti-bot: uma segunda tentativa costuma passar.
      if (!/search failed: 5\d\d|abort/i.test(String(error?.message ?? ""))) throw error;
      await new Promise((r) => setTimeout(r, 900));
      return this.searchOnce(query);
    }
  }

  async searchOnce(query) {
    const q = String(query ?? "").trim();
    if (!q) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=br-pt`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": "Mozilla/5.0",
          accept: "text/html,application/xhtml+xml"
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`search failed: ${response.status}`);
      }

      return parseSearchHtml(await response.text(), this.maxResults);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Resultados no formato do bloco [WEB SEARCH] do prompt (com trecho, que é onde está a resposta). */
export function formatSearchResults(results = []) {
  return results
    .map((item, index) => `${index + 1}. ${item.title}${item.snippet ? ` — ${item.snippet}` : ""} (${item.url})`)
    .join("\n");
}

