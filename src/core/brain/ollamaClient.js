export class OllamaClient {
  constructor({ baseUrl, model, apiKey, temperature = 0.65, numPredict = null } = {}) {
    this.baseUrl = String(baseUrl ?? "").replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
    const t = Number(temperature);
    this.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.65;
    const np = numPredict == null ? null : Number(numPredict);
    this.numPredict =
      np != null && Number.isFinite(np) && np > 0 ? Math.min(8192, Math.floor(np)) : null;
  }

  _headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async generate(prompt) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: this.temperature,
          ...(this.numPredict != null ? { num_predict: this.numPredict } : {})
        }
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data.response;
  }
}
