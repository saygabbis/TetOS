import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Internet pras habilidades da Teto: ela pode se conectar sozinha a qualquer API/página PÚBLICA
 * (GET ou POST com JSON), sem segredo nosso junto. Bloqueia endereço interno (localhost, rede local,
 * metadados da nuvem) inclusive via redirecionamento, limita tamanho e tempo.
 */

const MAX_BYTES = 300_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** IP de rede interna/reservada (não pode). */
export function isPrivateAddress(ip = "") {
  const v = String(ip).toLowerCase().replace(/^::ffff:/, "");
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (isIP(v) === 6) return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  return true;
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error("endereço inválido");
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error("só http/https");
  if (url.username || url.password) throw new Error("endereço com senha não");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error("endereço interno não");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("só portas 80/443");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("não achei esse site");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error("endereço interno não");
  return url;
}

/**
 * GET/POST num endereço público. Devolve JSON (se a resposta for JSON) ou texto.
 * @param {string} rawUrl
 * @param {{ metodo?: "GET"|"POST", corpo?: any, cabecalhos?: Record<string,string> }} opts
 */
export async function publicFetch(rawUrl, { metodo = "GET", corpo = undefined, cabecalhos = {} } = {}) {
  const method = String(metodo).toUpperCase() === "POST" ? "POST" : "GET";
  const headers = { "user-agent": "TetoBot/1.0 (+habilidade)", accept: "application/json, text/*;q=0.8" };
  for (const [k, v] of Object.entries(cabecalhos ?? {})) {
    if (/^(cookie|authorization|host|proxy-|x-forwarded)/i.test(k)) continue; // nada de credencial
    headers[String(k).slice(0, 60)] = String(v).slice(0, 300);
  }
  let body;
  if (method === "POST" && corpo !== undefined) {
    body = typeof corpo === "string" ? corpo : JSON.stringify(corpo);
    if (body.length > 20_000) throw new Error("corpo grande demais");
    if (typeof corpo !== "string") headers["content-type"] = "application/json";
  }
  let url = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await fetch(url, { method: hop ? "GET" : method, headers, body: hop ? undefined : body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await assertPublicUrl(new URL(res.headers.get("location"), url).href);
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/json|text|xml|html/i.test(type) && type) throw new Error(`tipo de resposta não suportado (${type.split(";")[0]})`);
    const reader = res.body?.getReader();
    let size = 0;
    const chunks = [];
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    if (/json/i.test(type)) {
      try {
        return { status: res.status, json: JSON.parse(text) };
      } catch {
        /* cai no texto */
      }
    }
    const plain = /html/i.test(type) ? text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : text;
    return { status: res.status, text: plain.slice(0, 20_000) };
  }
  throw new Error("redirecionamentos demais");
}

/** Domínios que o código de uma habilidade cita (pra dona saber onde ela se conecta). */
export function domainsIn(code = "") {
  return [...new Set([...String(code).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))].slice(0, 8);
}
