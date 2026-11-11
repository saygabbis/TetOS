import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Conta o gasto da API da OpenAI por dia (estimativa pela tabela de preço, em US$ por 1M tokens).
 * Serve pra duas coisas: `.gastos` mostrar quanto já foi, e o teto diário pausar as tarefas de fundo
 * (mente, estudo, autoevolução) antes de comer o saldo. A conversa com gente nunca é barrada.
 */

/** US$ por 1M tokens: [entrada, entrada em cache, saída]. */
const PRICES = [
  [/^gpt-6-luna/, [0.1, 0.01, 0.5]],
  [/^gpt-6\.1-terra/, [1, 0.05, 5]],
  [/^gpt-6(\.1)?-sol/, [2, 0.2, 10]],
  [/^gpt-6-astra/, [10, 1, 50]],
  [/^gpt-4o-mini-transcribe/, [1.25, 1.25, 5]],
  [/^gpt-4o-mini-tts/, [0.6, 0.6, 12]],
  [/^gpt-image-1-mini/, [2, 0.2, 8]]
];
const FALLBACK_PRICE = [0.1, 0.01, 0.5];
const TOOL_PRICES = { web_search: 0.01 };

export function priceFor(model = "") {
  const m = String(model).toLowerCase();
  return PRICES.find(([re]) => re.test(m))?.[1] ?? FALLBACK_PRICE;
}

export function costOf(model, usage = {}) {
  const [inP, cachedP, outP] = priceFor(model);
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0) || 0;
  const cached = Number(usage?.input_tokens_details?.cached_tokens ?? 0) || 0;
  const output = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0) || 0;
  return ((input - cached) * inP + cached * cachedP + output * outP) / 1_000_000;
}

export class OpenAIUsageMeter {
  constructor({ path = "./data/openaiUsage.json", dailyBudgetUsd = 0, timeZone = "America/Sao_Paulo", now = () => new Date() } = {}) {
    this.path = path;
    const b = Number(dailyBudgetUsd);
    this.dailyBudgetUsd = Number.isFinite(b) && b > 0 ? b : 0;
    this.timeZone = timeZone;
    this.now = now;
    this.state = this._load();
    this._timer = null;
  }

  _load() {
    try {
      if (this.path && existsSync(this.path)) return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      /* começa do zero */
    }
    return { days: {} };
  }

  _save() {
    if (!this.path || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        // Guarda só os últimos 60 dias.
        const keys = Object.keys(this.state.days).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete this.state.days[k];
        writeFileSync(this.path, JSON.stringify(this.state, null, 2));
      } catch {
        /* contador é só estimativa: não derruba nada */
      }
    }, 2000);
    this._timer.unref?.();
  }

  today() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone }).format(this.now());
  }

  _day() {
    const key = this.today();
    this.state.days[key] ??= { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, byPurpose: {} };
    return this.state.days[key];
  }

  record({ model, usage, purpose = "chat" } = {}) {
    if (!usage) return;
    this.add(costOf(model, usage), purpose, usage);
  }

  recordTool(tool, purpose = "busca") {
    this.add(TOOL_PRICES[tool] ?? 0, purpose);
  }

  add(usd = 0, purpose = "chat", usage = null) {
    const day = this._day();
    day.usd += usd;
    day.calls += 1;
    day.inputTokens += Number(usage?.input_tokens ?? 0) || 0;
    day.outputTokens += Number(usage?.output_tokens ?? 0) || 0;
    day.byPurpose[purpose] = (day.byPurpose[purpose] ?? 0) + usd;
    this.state.totalUsd = (this.state.totalUsd ?? 0) + usd;
    this._save();
  }

  spentToday() {
    return this.state.days[this.today()]?.usd ?? 0;
  }

  overBudget() {
    return this.dailyBudgetUsd > 0 && this.spentToday() >= this.dailyBudgetUsd;
  }

  /** Texto curto pro `.gastos`. */
  summary() {
    const day = this.state.days[this.today()];
    const fmt = (v) => `US$ ${Number(v ?? 0).toFixed(4)}`;
    const lines = [`💸 OpenAI hoje: ${fmt(day?.usd)} em ${day?.calls ?? 0} chamadas`];
    if (this.dailyBudgetUsd) lines.push(`teto diário das tarefas de fundo: US$ ${this.dailyBudgetUsd.toFixed(2)}`);
    const parts = Object.entries(day?.byPurpose ?? {}).sort((a, b) => b[1] - a[1]);
    if (parts.length) lines.push(parts.map(([k, v]) => `• ${k}: ${fmt(v)}`).join("\n"));
    const last7 = Object.entries(this.state.days).sort().slice(-7);
    lines.push(`últimos ${last7.length} dias: ${fmt(last7.reduce((s, [, d]) => s + (d.usd ?? 0), 0))}`);
    lines.push(`total contado: ${fmt(this.state.totalUsd)} (estimativa; o valor certo fica no painel da OpenAI)`);
    return lines.join("\n");
  }
}
