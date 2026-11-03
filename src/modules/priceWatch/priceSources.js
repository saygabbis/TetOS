// Onde ela procura preço: páginas públicas de busca. Amazon, Magalu, Casas Bahia etc. chegam pelo
// Buscapé (que compara as lojas); Mercado Livre e Amazon direto bloqueiam acesso de servidor.
import {
  normalizeText,
  parseAliexpressSearch,
  parseBuscapeProduct,
  parseBuscapeSearch,
  parseKabumSearch,
  queryVariants
} from "./priceParsing.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const SOURCES = {
  buscape: {
    label: "Buscapé",
    url: (q) => `https://www.buscape.com.br/search?q=${encodeURIComponent(q)}`,
    parse: parseBuscapeSearch
  },
  kabum: {
    label: "KaBuM!",
    url: (q) => `https://www.kabum.com.br/busca/${encodeURIComponent(normalizeText(q).replace(/ /g, "-"))}`,
    parse: parseKabumSearch
  },
  aliexpress: {
    label: "AliExpress",
    url: (q) => `https://pt.aliexpress.com/w/wholesale-${encodeURIComponent(normalizeText(q).replace(/ /g, "-"))}.html`,
    parse: parseAliexpressSearch
  }
};

export class PriceSources {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 20_000, gapMs = 1_200, sources = SOURCES } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.gapMs = gapMs;
    this.sources = sources;
  }

  async getHtml(url) {
    const res = await this.fetch(url, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml", "accept-language": "pt-BR,pt;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  async pause() {
    if (this.gapMs > 0) await new Promise((r) => setTimeout(r, this.gapMs));
  }

  /**
   * Procura em todos os sites (frase inteira e só marca/modelo). Um site fora do ar não derruba os
   * outros: o erro vai em `errors`. `allVariants`: no monitoramento, roda as duas versões sempre
   * (o item escolhido pode ter vindo de qualquer uma).
   */
  async search(query, { allVariants = false } = {}) {
    const offers = [];
    const errors = [];
    let first = true;
    for (const [name, src] of Object.entries(this.sources)) {
      const keysBefore = offers.length;
      for (const q of queryVariants(query)) {
        if (!first) await this.pause();
        first = false;
        try {
          offers.push(...src.parse(await this.getHtml(src.url(q))));
        } catch (error) {
          errors.push({ source: name, error: String(error?.message ?? error) });
        }
        // A frase inteira já achou coisa nesse site: não precisa da versão curta.
        if (!allVariants && offers.length > keysBefore) break;
      }
    }
    return { offers, errors };
  }

  /** Página do produto no Buscapé (lojas + histórico de ~40 dias). */
  async buscapeProduct(url) {
    try {
      return parseBuscapeProduct(await this.getHtml(url));
    } catch {
      return null;
    }
  }
}
