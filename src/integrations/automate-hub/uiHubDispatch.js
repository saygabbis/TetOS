import { getSessionTokenFromEnv } from "../../infra/api/auth/sessionAuth.js";

function normalizePath(path) {
  if (!path || typeof path !== "string") {
    throw new Error("path inválido");
  }
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  if (!trimmed.startsWith("/ui/")) {
    throw new Error("apenas rotas /ui/* são permitidas no túnel do hub");
  }
  return trimmed;
}

/**
 * Executa requisições `/ui/*` contra a API TetOS local (mesmos handlers HTTP),
 * autorizado como o dono via `TETOS_UI_SESSION_TOKEN`.
 */
export function createUiHubDispatcher(baseUrl, { sessionToken } = {}) {
  if (!baseUrl) {
    throw new Error("baseUrl é obrigatório para o dispatcher do hub");
  }
  const ownerToken = sessionToken ?? getSessionTokenFromEnv();
  const origin = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  return async function dispatchUiRequest({ method = "GET", path, headers = {}, body }) {
    const safePath = normalizePath(path);
    const url = `${origin}${safePath}`;
    const hasBody = body !== undefined && body !== null;
    const response = await fetch(url, {
      method: String(method).toUpperCase(),
      headers: {
        authorization: `Bearer ${ownerToken}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });

    const text = await response.text();
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    return {
      status: response.status,
      headers: responseHeaders,
      body: text,
    };
  };
}
