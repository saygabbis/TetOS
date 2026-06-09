export class OllamaClient {
  constructor({
    baseUrl,
    model,
    apiKey,
    temperature = 0.65,
    numPredict = null,
    timeoutMs = 25000
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
    this.timeoutMs = Number.isFinite(tm) && tm > 0 ? Math.floor(tm) : 25000;
  }

  _headers() {
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async generate(prompt) {
    const attempts = [];
    if (this.numPredict != null) {
      attempts.push(this.numPredict);
      if (this.numPredict < 2048) {
        attempts.push(Math.min(8192, this.numPredict * 4));
      }
    } else {
      attempts.push(null);
    }

    let lastError = null;
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        return await this._generateOnce(prompt, attempts[i]);
      } catch (error) {
        lastError = error;
        const retryable =
          i < attempts.length - 1 &&
          /empty response|done_reason=length/i.test(String(error?.message ?? ""));
        if (!retryable) throw error;
      }
    }
    throw lastError ?? new Error("Ollama error: empty response");
  }

  async _generateOnce(prompt, numPredict) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: {
          temperature: this.temperature,
          ...(numPredict != null ? { num_predict: numPredict } : {})
        }
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const text = String(data?.response ?? "").trim();
    if (!text) {
      const reason = data?.done_reason ?? "unknown";
      const thinkingLen = String(data?.thinking ?? "").length;
      throw new Error(
        `Ollama error: empty response (done_reason=${reason}, thinking_chars=${thinkingLen}, num_predict=${numPredict ?? "none"})`
      );
    }
    return text;
  }
}
