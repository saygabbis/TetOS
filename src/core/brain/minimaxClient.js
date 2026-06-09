export class MiniMaxClient {
  constructor({
    baseUrl = "https://api.minimax.io",
    model = "MiniMax-M2.7",
    apiKey,
    temperature = 0.65,
    numPredict = null,
    timeoutMs = 45000,
    thinking = null
  } = {}) {
    this.baseUrl = String(baseUrl ?? "").replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
    const t = Number(temperature);
    this.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.65;
    const np = numPredict == null ? null : Number(numPredict);
    this.numPredict =
      np != null && Number.isFinite(np) && np > 0 ? Math.min(8192, Math.floor(np)) : null;
    const tm = Number(timeoutMs);
    this.timeoutMs = Number.isFinite(tm) && tm > 0 ? tm : 45000;
    this.thinking = thinking;
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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const body = {
      model: this.model,
      messages: [{ role: "user", content: String(prompt ?? "") }],
      temperature: this.temperature,
      ...(this.numPredict != null ? { max_completion_tokens: this.numPredict } : {}),
      ...(this.thinking ? { thinking: this.thinking } : {})
    };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`MiniMax error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content == null || content === "") {
      throw new Error("MiniMax error: empty response");
    }
    return typeof content === "string" ? content : JSON.stringify(content);
  }
}
