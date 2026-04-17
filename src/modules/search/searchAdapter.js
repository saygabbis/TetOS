export class SearchAdapter {
  constructor({ timeoutMs = 12000, maxResults = 5 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResults = maxResults;
  }

  async search(query) {
    const q = String(query ?? "").trim();
    if (!q) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
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

      const html = await response.text();
      const matches = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gsi)];
      return matches.slice(0, this.maxResults).map((match) => ({
        url: String(match[1] ?? "").replace(/&amp;/g, "&"),
        title: String(match[2] ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      })).filter((item) => item.url && item.title);
    } finally {
      clearTimeout(timeout);
    }
  }
}
