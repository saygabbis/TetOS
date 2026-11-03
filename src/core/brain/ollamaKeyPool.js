import { createHash } from "node:crypto";
import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";

/**
 * Várias contas da Ollama Cloud: usa a primeira que ainda tem cota; quando uma responde que bateu o
 * limite, fica de lado até o limite voltar (mensal → dia 1º, semanal → 7 dias, por hora/sessão →
 * 1 h) e a chamada repete na hora com a próxima. O estado vai pra disco sem a chave (só um hash),
 * pra um reinício não ficar batendo numa conta esgotada.
 */

const HOUR = 3_600_000;

function stripQuotes(value) {
  const s = String(value ?? "").trim();
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1).trim() : s;
}

/** TETOS_OLLAMA_API_KEY / OLLAMA_API_KEY (a principal) + TETOS_OLLAMA_API_KEYS (vírgula, ; ou espaço). */
export function parseOllamaApiKeys(env = process.env) {
  const parts = [env.TETOS_OLLAMA_API_KEY, env.OLLAMA_API_KEY, env.TETOS_OLLAMA_API_KEYS].filter(Boolean).map(stripQuotes);
  const keys = [];
  for (const part of parts) {
    for (const raw of part.split(/[,;\s]+/)) {
      const key = stripQuotes(raw);
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

const idOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 12);

/** Resposta de erro da Ollama → por quanto tempo deixar a conta de lado (null = não é limite). */
export function exhaustionCooldown(status, text, now = Date.now()) {
  const t = String(text ?? "").toLowerCase();
  // 403 também vem de "modelo pede assinatura" — aí trocar de conta não muda nada.
  if (status === 401 || (status === 403 && /unauthori[sz]ed|invalid|api key/.test(t))) return { until: now + 24 * HOUR, reason: "chave recusada" };
  // 402 "Add usage credits to use cloud models": a conta não tem nuvem (sem plano/créditos).
  if (status === 402 || /usage credits|add credits/.test(t)) return { until: now + 6 * HOUR, reason: "conta sem créditos de nuvem" };
  if (status !== 429 && !/usage limit|quota/.test(t)) return null;
  if (/month/.test(t)) {
    const d = new Date(now);
    return { until: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), reason: "limite mensal" };
  }
  if (/week/.test(t)) return { until: now + 7 * 24 * HOUR, reason: "limite semanal" };
  if (/usage limit|quota|session|hour/.test(t)) return { until: now + HOUR, reason: "limite de uso" };
  // 429 sem dizer de quê: muita requisição de uma vez, volta logo.
  return { until: now + 60_000, reason: "muitas requisições" };
}

export class OllamaKeyPool {
  constructor({ keys = [], statePath = null, now = () => Date.now(), logger = console } = {}) {
    this.keys = [...new Set(keys.filter(Boolean))];
    this.statePath = statePath;
    this.now = now;
    this.log = logger;
    const saved = statePath ? readJson(statePath, {}) : {};
    this.blocked = new Map(Object.entries(saved.blocked ?? {}));
  }

  get size() {
    return this.keys.length;
  }

  label(key) {
    return `${this.keys.indexOf(key) + 1}/${this.keys.length}`;
  }

  isAvailable(key) {
    const b = this.blocked.get(idOf(key));
    return !b || b.until <= this.now();
  }

  /** A primeira conta com cota (na ordem do .env). Todas esgotadas: a que volta primeiro. */
  current(exclude = []) {
    const pool = this.keys.filter((k) => !exclude.includes(k));
    if (!pool.length) return null;
    const ok = pool.find((k) => this.isAvailable(k));
    if (ok) return ok;
    return [...pool].sort((a, b) => this.blocked.get(idOf(a)).until - this.blocked.get(idOf(b)).until)[0];
  }

  /** Marca a conta se o erro for de limite. Devolve true se marcou (vale tentar outra). */
  noteFailure(key, status, text) {
    const cd = exhaustionCooldown(status, text, this.now());
    if (!cd || !key) return false;
    const id = idOf(key);
    const already = this.blocked.get(id);
    this.blocked.set(id, cd);
    this.save();
    if (!already || already.until <= this.now()) {
      const next = this.current([key]);
      const back = new Date(cd.until).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
      this.log.warn?.(
        `[ollama] conta ${this.label(key)}: ${cd.reason} (volta ${back})${next && this.isAvailable(next) ? ` — trocando pra conta ${this.label(next)}` : " — sem outra conta com cota"}`
      );
    }
    return true;
  }

  save() {
    if (!this.statePath) return;
    const now = this.now();
    const blocked = Object.fromEntries([...this.blocked].filter(([, b]) => b.until > now));
    writeJsonDeferred(this.statePath, { blocked });
  }
}
