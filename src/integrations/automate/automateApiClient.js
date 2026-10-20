/**
 * Lado do WhatsApp da ponte com o AutoMate: o runner não fala com o PC, pede pra API (que fala).
 * Ligado quando há TETOS_API_TOKEN (e TETOS_AUTOMATE_WHATSAPP diferente de "false").
 */
export class AutomateApiClient {
  constructor({
    baseUrl = process.env.TETOS_API_URL ?? `http://127.0.0.1:${process.env.TETOS_PORT || 3000}`,
    token = process.env.TETOS_API_TOKEN ?? "",
    enabled = process.env.TETOS_AUTOMATE_WHATSAPP !== "false"
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.token = String(token).trim();
    this.enabled = Boolean(enabled && this.token);
    this.statusCache = { at: 0, online: false };
  }

  async request(path, { method = "GET", body = null, timeoutMs = 8000 } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  /** PC da dona com o AutoMate aberto? (cache de 1 min; API fora do ar = offline). */
  async isPcOnline() {
    if (!this.enabled) return false;
    if (Date.now() - this.statusCache.at < 60_000) return this.statusCache.online;
    try {
      const { ok, json } = await this.request("/automate/status", { timeoutMs: 2000 });
      this.statusCache = { at: Date.now(), online: Boolean(ok && json.online) };
    } catch {
      this.statusCache = { at: Date.now(), online: false };
    }
    return this.statusCache.online;
  }

  /** @returns {{ ok: true, runId } | { ok: false, reason: "offline"|"api"|"error", message? }} */
  async run(intent, jid) {
    if (!this.enabled) return { ok: false, reason: "api" };
    try {
      const { ok, status, json } = await this.request("/automate/whatsapp/run", { method: "POST", body: { intent, jid }, timeoutMs: 20_000 });
      if (ok) return { ok: true, runId: json.runId };
      if (status === 409) {
        this.statusCache = { at: Date.now(), online: false };
        return { ok: false, reason: "offline" };
      }
      return { ok: false, reason: "error", message: json.error };
    } catch (error) {
      return { ok: false, reason: "api", message: error?.message };
    }
  }
}
