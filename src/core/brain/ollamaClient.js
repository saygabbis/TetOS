export class OllamaClient {
  constructor({ baseUrl, model, apiKey }) {
    this.baseUrl = String(baseUrl ?? "").replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
  }

  _headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async generate(prompt) {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ model: this.model, prompt, stream: false })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data.response;
  }
}
