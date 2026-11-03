import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaClient } from "../../src/core/brain/ollamaClient.js";
import { OllamaKeyPool, exhaustionCooldown, parseOllamaApiKeys } from "../../src/core/brain/ollamaKeyPool.js";

const MONTHLY = '{"error":"you (x) have reached your monthly usage limit, upgrade for higher limits"}';
const quiet = { warn() {} };

/** fetch falso: responde por chave (Authorization) o que a tabela disser. */
function fakeFetch(byKey) {
  const calls = [];
  const fn = vi.fn(async (_url, init) => {
    const key = String(init.headers.Authorization ?? "").replace("Bearer ", "");
    calls.push(key);
    const r = byKey[key] ?? { status: 200, body: { response: `oi da ${key}` } };
    return {
      ok: r.status === 200,
      status: r.status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
      json: async () => r.body
    };
  });
  fn.calls = calls;
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("contas da Ollama", () => {
  it("lê a principal + a lista, sem repetir e sem aspas", () => {
    expect(parseOllamaApiKeys({ TETOS_OLLAMA_API_KEY: "a", TETOS_OLLAMA_API_KEYS: '"a, b;c"' })).toEqual(["a", "b", "c"]);
    expect(parseOllamaApiKeys({ OLLAMA_API_KEY: "z" })).toEqual(["z"]);
    expect(parseOllamaApiKeys({})).toEqual([]);
  });

  it("limite mensal vale até o dia 1º; semanal 7 dias; 429 solto 1 min; erro comum não conta", () => {
    const now = Date.UTC(2026, 10, 3, 12);
    expect(exhaustionCooldown(429, MONTHLY, now).until).toBe(Date.UTC(2026, 11, 1));
    expect(exhaustionCooldown(429, "weekly usage limit", now).until).toBe(now + 7 * 86_400_000);
    expect(exhaustionCooldown(429, "too many requests", now).until).toBe(now + 60_000);
    expect(exhaustionCooldown(401, "unauthorized", now).reason).toBe("chave recusada");
    expect(exhaustionCooldown(403, "this model requires a subscription", now)).toBeNull();
    expect(exhaustionCooldown(500, "internal error", now)).toBeNull();
  });

  it("conta esgotada: a mesma chamada repete com a próxima e as seguintes já vão direto nela", async () => {
    const fetch = fakeFetch({ k1: { status: 429, body: MONTHLY } });
    vi.stubGlobal("fetch", fetch);
    const pool = new OllamaKeyPool({ keys: ["k1", "k2", "k3"], logger: quiet });
    const client = new OllamaClient({ baseUrl: "http://x", model: "m", apiKey: "k1", keyPool: pool });
    expect(await client.generate("oi")).toBe("oi da k2");
    expect(await client.generate("oi de novo")).toBe("oi da k2");
    expect(fetch.calls).toEqual(["k1", "k2", "k2"]);
  });

  it("todas esgotadas: tenta cada uma só uma vez e devolve o erro da Ollama", async () => {
    const fetch = fakeFetch({ k1: { status: 429, body: MONTHLY }, k2: { status: 429, body: MONTHLY } });
    vi.stubGlobal("fetch", fetch);
    const pool = new OllamaKeyPool({ keys: ["k1", "k2"], logger: quiet });
    const client = new OllamaClient({ baseUrl: "http://x", model: "m", keyPool: pool });
    await expect(client.generate("oi")).rejects.toThrow(/429 .*monthly usage limit/);
    expect(fetch.calls).toEqual(["k1", "k2"]);
    await expect(client.generate("oi")).rejects.toThrow(/429/);
    expect(fetch.calls).toHaveLength(3); // depois disso, uma tentativa por chamada
  });

  it("erro que não é limite não troca de conta", async () => {
    const fetch = fakeFetch({ k1: { status: 500, body: "boom" } });
    vi.stubGlobal("fetch", fetch);
    const pool = new OllamaKeyPool({ keys: ["k1", "k2"], logger: quiet });
    const client = new OllamaClient({ baseUrl: "http://x", model: "m", keyPool: pool });
    await expect(client.generate("oi")).rejects.toThrow(/500 boom/);
    expect(fetch.calls).toEqual(["k1"]);
  });

  it("chat (visão) também troca; e a conta volta quando o limite passa", async () => {
    let now = Date.UTC(2026, 10, 3, 12);
    const fetch = fakeFetch({ k1: { status: 429, body: "session usage limit" }, k2: { status: 200, body: { message: { content: "vi uma gata" } } } });
    vi.stubGlobal("fetch", fetch);
    const pool = new OllamaKeyPool({ keys: ["k1", "k2"], now: () => now, logger: quiet });
    const client = new OllamaClient({ baseUrl: "http://x", model: "m", keyPool: pool });
    expect(await client.chat([{ role: "user", content: "o que tem?" }])).toBe("vi uma gata");
    expect(pool.current()).toBe("k2");
    now += 2 * 3_600_000;
    expect(pool.current()).toBe("k1");
  });
});
