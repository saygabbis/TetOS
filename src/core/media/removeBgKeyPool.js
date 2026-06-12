/**
 * Pool de chaves remove.bg — rotação quando créditos acabam; local só quando todas esgotam.
 */

const CREDITS_CACHE_MS = 5 * 60 * 1000;

function maskKey(key) {
  const s = String(key ?? "");
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}…${s.slice(-3)}`;
}

function stripEnvQuotes(value) {
  const s = String(value ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/** Aceita REMOVEBG_API_KEY / REMOVEBG_API_KEYS (vírgula ou ponto-e-vírgula; aspas ok). */
export function parseRemoveBgApiKeys(env = process.env) {
  const parts = [
    env.REMOVEBG_API_KEY,
    env.TETOS_REMOVEBG_API_KEY,
    env.REMOVEBG_API_KEYS,
    env.TETOS_REMOVEBG_API_KEYS
  ]
    .filter(Boolean)
    .map(stripEnvQuotes);

  const keys = [];
  const seen = new Set();
  for (const part of parts) {
    for (const raw of part.split(/[,;]/)) {
      const key = stripEnvQuotes(raw.trim());
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * Créditos disponíveis: plano pago usa credits.total; free usa api.free_calls (ex.: 41/50).
 * @returns {{ available: number, source: "paid"|"free"|"none" } | null}
 */
function parseRemoveBgAccountCredits(body) {
  const attrs = body?.data?.attributes ?? {};
  const paid = Number(attrs.credits?.total ?? 0);
  const freeCalls = Number(attrs.api?.free_calls ?? NaN);

  if (Number.isFinite(paid) && paid > 0) {
    return { available: paid, source: "paid" };
  }
  if (Number.isFinite(freeCalls)) {
    return { available: Math.max(0, freeCalls), source: "free" };
  }
  if (Number.isFinite(paid)) {
    return { available: Math.max(0, paid), source: "paid" };
  }
  return null;
}

async function fetchRemoveBgCredits(apiKey) {
  try {
    const res = await fetch("https://api.remove.bg/v1.0/account", {
      headers: { "X-Api-Key": apiKey }
    });
    if (!res.ok) return null;
    const body = await res.json();
    return parseRemoveBgAccountCredits(body);
  } catch {
    return null;
  }
}

class RemoveBgKeyPool {
  constructor() {
    /** @type {Set<string>} */
    this.exhausted = new Set();
    /** @type {Map<string, { credits: number, source: string, at: number }>} */
    this.creditsCache = new Map();
    this.refreshPromise = null;
  }

  markExhausted(apiKey, reason = "quota") {
    if (!apiKey) return;
    this.exhausted.add(apiKey);
    const prev = this.creditsCache.get(apiKey);
    this.creditsCache.set(apiKey, { credits: 0, source: prev?.source ?? "none", at: Date.now() });
    if (process.env.TETOS_REMOVEBG_DEBUG) {
      console.warn(`[removebg] chave ${maskKey(apiKey)} marcada esgotada (${reason})`);
    }
  }

  noteSuccess(apiKey) {
    if (!apiKey) return;
    const cached = this.creditsCache.get(apiKey);
    if (cached && cached.credits > 0) {
      this.creditsCache.set(apiKey, {
        credits: cached.credits - 1,
        source: cached.source,
        at: Date.now()
      });
    }
  }

  clearExhausted(apiKey) {
    if (!apiKey) return;
    this.exhausted.delete(apiKey);
  }

  async refreshCredits(keys) {
    const list = keys.filter(Boolean);
    if (list.length === 0) return;

    const now = Date.now();
    const toCheck = list.filter((key) => {
      const cached = this.creditsCache.get(key);
      return !cached || now - cached.at >= CREDITS_CACHE_MS || this.exhausted.has(key);
    });
    if (toCheck.length === 0) return;

    await Promise.all(
      toCheck.map(async (key) => {
        const parsed = await fetchRemoveBgCredits(key);
        if (parsed === null) return;
        const { available, source } = parsed;
        this.creditsCache.set(key, { credits: available, source, at: Date.now() });
        if (available <= 0) {
          this.markExhausted(key, "sem creditos");
        } else {
          this.clearExhausted(key);
          if (process.env.TETOS_REMOVEBG_DEBUG) {
            const label = source === "free" ? "previews free" : "creditos";
            console.info(`[removebg] chave ${maskKey(key)}: ${available} ${label}`);
          }
        }
      })
    );
  }

  async ensureRefreshed(keys) {
    if (!keys?.length) return;
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshCredits(keys).finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  /** Primeira chave disponível (não esgotada e com créditos > 0 se soubermos). */
  async pickKey(keys) {
    if (!keys?.length) return null;
    await this.ensureRefreshed(keys);

    for (const key of keys) {
      if (this.exhausted.has(key)) continue;
      const cached = this.creditsCache.get(key);
      if (cached && cached.credits <= 0) {
        this.exhausted.add(key);
        continue;
      }
      return key;
    }
    return null;
  }

  hasAvailableKey(keys) {
    return keys.some((key) => key && !this.exhausted.has(key));
  }

  availableCount(keys) {
    return keys.filter((key) => key && !this.exhausted.has(key)).length;
  }
}

export const removeBgKeyPool = new RemoveBgKeyPool();
