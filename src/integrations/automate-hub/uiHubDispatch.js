import { getSessionTokenFromEnv } from "../../infra/api/auth/sessionAuth.js";

function normalizePath(path) {
  if (!path || typeof path !== "string") {
    throw new Error("path inválido");
  }
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  if (!trimmed.startsWith("/ui/")) {
    throw new Error("apenas rotas /ui/* são permitidas no túnel do hub");
  }
  const pathname = trimmed.split("?")[0] ?? trimmed;
  if (pathname.startsWith("/ui/devices")) {
    throw new Error("rota /ui/devices* não exposta pelo túnel do hub");
  }
  return trimmed;
}

function decodeRequestBody(body, bodyEncoding) {
  if (body === undefined || body === null) return undefined;
  if (bodyEncoding === "base64" && typeof body === "string") {
    return Buffer.from(body, "base64");
  }
  return body;
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

  return async function dispatchUiRequest({
    method = "GET",
    path,
    headers = {},
    body,
    bodyEncoding,
  }) {
    const safePath = normalizePath(path);
    const url = `${origin}${safePath}`;
    const decodedBody = decodeRequestBody(body, bodyEncoding);
    const hasBody = decodedBody !== undefined && decodedBody !== null;
    const isBuffer = Buffer.isBuffer(decodedBody);
    const outgoingHeaders = {
      ...headers,
      authorization: `Bearer ${ownerToken}`,
    };
    delete outgoingHeaders.Authorization;

    if (hasBody && !outgoingHeaders["content-type"] && !outgoingHeaders["Content-Type"]) {
      outgoingHeaders["content-type"] = isBuffer ? "application/octet-stream" : "application/json";
    }

    const response = await fetch(url, {
      method: String(method).toUpperCase(),
      headers: outgoingHeaders,
      body: hasBody
        ? isBuffer
          ? decodedBody
          : typeof decodedBody === "string"
            ? decodedBody
            : JSON.stringify(decodedBody)
        : undefined,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    const contentType = responseHeaders["content-type"] ?? "";
    const isText =
      !contentType ||
      contentType.includes("json") ||
      contentType.includes("text") ||
      contentType.includes("javascript") ||
      contentType.includes("xml");

    if (isText) {
      return {
        status: response.status,
        headers: responseHeaders,
        body: buffer.length ? buffer.toString("utf8") : null,
        bodyEncoding: "utf8",
      };
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: buffer.length ? buffer.toString("base64") : null,
      bodyEncoding: "base64",
    };
  };
}
