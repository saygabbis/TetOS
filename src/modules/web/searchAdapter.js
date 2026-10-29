const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");

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
  constructor({ timeoutMs = 12000, maxResults = 5 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResults = maxResults;
  }

  async search(query) {
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
