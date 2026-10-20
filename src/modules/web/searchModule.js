export class SearchModule {
  constructor({ adapter, enabled = true } = {}) {
    this.adapter = adapter;
    this.enabled = enabled;
  }

  isEnabled() {
    return Boolean(this.enabled && this.adapter);
  }

  canHandle(text) {
    const t = String(text ?? "").trim().toLowerCase();
    if (!t) return false;
    return /\b(pesquisa|pesquisar|procura|procurar|busca|buscar|pesquisa na web|na internet|not[ií]cia|not[ií]cias|pesquisa pra mim)\b/.test(t);
  }

  extractQuery(text) {
    const t = String(text ?? "").trim();
    return t
      .replace(/^.*?\b(pesquisa|pesquisar|procura|procurar|busca|buscar)\b\s*/i, "")
      .replace(/^na web\s*/i, "")
      .replace(/^na internet\s*/i, "")
      .trim() || t;
  }

  async handle(text) {
    if (!this.isEnabled() || !this.canHandle(text)) return null;
    const query = this.extractQuery(text);
    const results = await this.adapter.search(query);
    return {
      query,
      results
    };
  }
}
