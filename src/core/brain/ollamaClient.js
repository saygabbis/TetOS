export class OllamaClient {
  constructor({ baseUrl, model }) {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async generate(prompt) {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
