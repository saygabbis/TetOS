import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { OpenAIUsageMeter } from "./openaiUsage.js";

/**
 * Cliente da API da OpenAI (Responses API) — mesmo contrato do OllamaClient:
 *  - generate(prompt) → texto
 *  - generateStream(prompt, onChunk) → texto (tokens chegam no onChunk)
 *  - chat(messages, { imagePaths }) → texto (visão: imagens locais viram input_image)
 *  - webSearch(query) → { text, results } (ferramenta web_search da OpenAI)
 *
 * Modelos de raciocínio (gpt-6-luna etc.): o max_output_tokens conta o raciocínio também, então
 * quando reasoning != none somamos uma folga; temperature só vai quando reasoning = none.
 */

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

const REASONING_HEADROOM = { none: 0, minimal: 600, low: 1200, medium: 3000, high: 6000, xhigh: 10000, max: 16000 };

export class OpenAIBudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenAIBudgetError";
  }
}

export class OpenAIClient {
  constructor({
    baseUrl = "https://api.openai.com/v1",
    model = "gpt-6-luna",
    apiKey,
    temperature = 0.65,
    numPredict = null,
    timeoutMs = 45000,
    reasoningEffort = "low",
    serviceTier = "",
    usage = null,
    critical = false,
    purpose = "chat"
  } = {}) {
    this.baseUrl = String(baseUrl ?? "").replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
    const t = Number(temperature);
    this.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : 0.65;
    const np = numPredict == null ? null : Number(numPredict);
    this.numPredict = np != null && Number.isFinite(np) && np > 0 ? Math.floor(np) : null;
    const tm = Number(timeoutMs);
    this.timeoutMs = Number.isFinite(tm) && tm > 0 ? Math.floor(tm) : 45000;
    this.reasoningEffort = String(reasoningEffort || "none").toLowerCase();
    this.serviceTier = String(serviceTier ?? "").trim();
    /** @type {OpenAIUsageMeter | null} */
    this.usage = usage;
    /** Conversa direta com gente: nunca é barrada pelo teto diário (só as tarefas de fundo são). */
    this.critical = Boolean(critical);
    this.purpose = purpose;
    /** Alguns modelos recusam temperature: descobre na 1ª vez e para de mandar. */
    this._noTemperature = this.reasoningEffort !== "none";
  }

  _headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  _checkBudget() {
    if (!this.apiKey) throw new Error("OpenAI error: sem chave (TETOS_OPENAI_API_KEY)");
    if (!this.critical && this.usage?.overBudget()) {
      throw new OpenAIBudgetError(
        `OpenAI: teto diário de US$ ${this.usage.dailyBudgetUsd} atingido — tarefas de fundo pausadas até amanhã`
      );
    }
  }

  _body(input, { stream = false, maxTokens = this.numPredict, tools = null } = {}) {
    // Prompt de texto: a persona/regras vão como instructions (papel de sistema) e só o turno vai
    // como fala do usuário. Antes ia tudo como mensagem do usuário e o modelo respondia "ao
    // documento", formal e numa bolha só. O prefixo fixo também entra no cache de prompt.
    const split = typeof input === "string" ? splitPrompt(input) : null;
    const body = {
      model: this.model,
      ...(split?.instructions ? { instructions: split.instructions } : {}),
      input: split ? split.input : input,
      store: false,
      prompt_cache_key: `tetos-${this.purpose}`,
      ...(stream ? { stream: true } : {})
    };
    if (this.reasoningEffort && this.reasoningEffort !== "default") {
      body.reasoning = { effort: this.reasoningEffort };
    }
    if (maxTokens != null) {
      body.max_output_tokens = maxTokens + (REASONING_HEADROOM[this.reasoningEffort] ?? 1200);
    }
    if (!this._noTemperature) body.temperature = this.temperature;
    if (this.serviceTier) body.service_tier = this.serviceTier;
    if (tools) body.tools = tools;
    return body;
  }

  async _post(path, body, signal) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal
      });
      if (response.ok) return response;
      const text = await response.text();
      // Parâmetro que o modelo não aceita: tira e tenta de novo (uma vez cada).
      if (response.status === 400 && /temperature/i.test(text) && "temperature" in body) {
        this._noTemperature = true;
        delete body.temperature;
        continue;
      }
      if (response.status === 400 && /prompt_cache_key/i.test(text) && "prompt_cache_key" in body) {
        delete body.prompt_cache_key;
        continue;
      }
      if (response.status === 400 && /service_tier/i.test(text) && "service_tier" in body) {
        this.serviceTier = "";
        delete body.service_tier;
        continue;
      }
      // Flex sem capacidade agora: vai no preço normal desta vez.
      if (response.status === 429 && body.service_tier === "flex" && !/insufficient_quota|billing/i.test(text)) {
        delete body.service_tier;
        continue;
      }
      // 429 de "rate limit" (não de saldo): espera um pouco e repete.
      if (response.status === 429 && !/insufficient_quota|billing/i.test(text) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(`OpenAI error: ${response.status} ${describeError(text)}`);
    }
    throw new Error("OpenAI error: parâmetros recusados");
  }

  _record(data) {
    this.usage?.record({ model: data?.model ?? this.model, usage: data?.usage, purpose: this.purpose });
  }

  async _respond(input, { maxTokens = this.numPredict, timeoutMs = this.timeoutMs, tools = null } = {}) {
    this._checkBudget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let limit = maxTokens;
      for (let i = 0; i < 2; i += 1) {
        const response = await this._post("/responses", this._body(input, { maxTokens: limit, tools }), controller.signal);
        const data = await response.json();
        this._record(data);
        const text = extractOutputText(data).trim();
        if (text) return { text, data };
        // Gastou tudo raciocinando: tenta de novo com mais espaço.
        if (data?.status === "incomplete" && limit != null && i === 0) {
          limit = Math.min(32000, limit * 4);
          continue;
        }
        throw new Error(
          `OpenAI error: empty response (status=${data?.status ?? "?"}, reason=${data?.incomplete_details?.reason ?? "?"})`
        );
      }
      throw new Error("OpenAI error: empty response");
    } finally {
      clearTimeout(timeout);
    }
  }

  async generate(prompt) {
    const { text } = await this._respond(String(prompt ?? ""));
    return text;
  }

  async generateStream(prompt, onChunk) {
    this._checkBudget();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let full = "";
    try {
      const response = await this._post("/responses", this._body(String(prompt ?? ""), { stream: true }), controller.signal);
      if (!response.body) return await this.generate(prompt);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          if (event?.type === "response.output_text.delta" && event.delta) {
            full += event.delta;
            onChunk?.(event.delta);
          } else if (event?.type === "response.completed" || event?.type === "response.incomplete") {
            this._record(event.response);
          } else if (event?.type === "error" || event?.type === "response.failed") {
            throw new Error(`OpenAI error: ${event?.error?.message ?? event?.response?.error?.message ?? "stream falhou"}`);
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    const text = full.trim();
    return text || (await this.generate(prompt));
  }

  /**
   * Chat multimodal. Imagens locais vão na última mensagem do usuário.
   * @param {{ role: string, content: string }[]} messages
   */
  async chat(messages = [], { imagePaths = [], timeoutMs = this.timeoutMs, detail = "low", maxTokens = undefined } = {}) {
    const images = encodeLocalImages(imagePaths);
    const input = (messages ?? []).map((m) => {
      const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "developer" : "user";
      const textType = role === "assistant" ? "output_text" : "input_text";
      return { role, content: [{ type: textType, text: String(m.content ?? "") }] };
    });
    const lastUser = [...input].reverse().find((m) => m.role === "user");
    if (images.length) {
      const target = lastUser ?? (input.push({ role: "user", content: [] }), input[input.length - 1]);
      for (const url of images) target.content.push({ type: "input_image", image_url: url, detail });
    }
    const { text } = await this._respond(input, { timeoutMs, ...(maxTokens ? { maxTokens } : {}) });
    return text;
  }

  /** Pesquisa na web pela própria OpenAI. Custa por chamada (~US$ 0,01): use só quando precisar. */
  async webSearch(query, { maxResults = 5 } = {}) {
    const q = String(query ?? "").trim();
    if (!q) return { text: "", results: [] };
    const { text, data } = await this._respond(
      `Pesquise na web e responda em português do Brasil, curto e direto, com os fatos mais recentes: ${q}`,
      { maxTokens: 700, timeoutMs: Math.max(this.timeoutMs, 60_000), tools: [{ type: "web_search" }] }
    );
    this.usage?.recordTool("web_search");
    const seen = new Set();
    const results = [];
    for (const ann of extractAnnotations(data)) {
      if (ann?.type !== "url_citation" || !ann.url || seen.has(ann.url)) continue;
      seen.add(ann.url);
      results.push({ url: ann.url, title: ann.title || ann.url, snippet: "" });
      if (results.length >= maxResults) break;
    }
    if (results.length) results[0].snippet = text.slice(0, 600);
    return { text, results };
  }
}

const INPUT_MARK = /\n\s*\[INPUT\]\s*\n/;

/**
 * Separa o prompt montado pelo Agent em { instructions, input }: tudo antes de [INPUT] é regra e
 * contexto (sistema); dali pra frente é o turno. Prompt sem marcador vai inteiro como input.
 */
export function splitPrompt(prompt) {
  const text = String(prompt ?? "");
  const m = INPUT_MARK.exec(text);
  if (!m || m.index < 200) return { instructions: "", input: text };
  return {
    instructions: text.slice(0, m.index).trim(),
    input: text.slice(m.index + m[0].length).trim()
  };
}

export function extractOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c?.type === "output_text" && c.text) parts.push(c.text);
    }
  }
  return parts.join("");
}

function extractAnnotations(data) {
  const out = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) out.push(...(c?.annotations ?? []));
  }
  return out;
}

function describeError(text = "") {
  try {
    const json = JSON.parse(text);
    const e = json?.error ?? json;
    return [e?.code, e?.message].filter(Boolean).join(": ").slice(0, 300) || String(text).slice(0, 300);
  } catch {
    return String(text).slice(0, 300);
  }
}

function encodeLocalImages(imagePaths = []) {
  const out = [];
  for (const p of imagePaths ?? []) {
    try {
      if (!p || !existsSync(p)) continue;
      const mime = MIME_BY_EXT[extname(p).toLowerCase()] ?? "image/jpeg";
      out.push(`data:${mime};base64,${readFileSync(p).toString("base64")}`);
    } catch {
      /* ignore */
    }
  }
  return out;
}

export { OpenAIUsageMeter };
