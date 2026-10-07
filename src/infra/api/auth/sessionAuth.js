const DEFAULT_DEV_TOKEN = "tetos-dev-session";

export function getSessionTokenFromEnv() {
  const fromEnv = process.env.TETOS_UI_SESSION_TOKEN?.trim();
  if (process.env.NODE_ENV === "production") {
    if (!fromEnv) {
      throw new Error("TETOS_UI_SESSION_TOKEN é obrigatório em produção");
    }
    return fromEnv;
  }
  return fromEnv || DEFAULT_DEV_TOKEN;
}

export function requireSession(req, res, next) {
  const expected = getSessionTokenFromEnv();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== expected) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  return next();
}

/**
 * Como requireSession, mas aceita `?token=` — necessário para <img>/<video>, que não enviam header Authorization.
 */
export function requireSessionOrQueryToken(req, res, next) {
  const expected = getSessionTokenFromEnv();
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const queryToken = typeof req.query?.token === "string" ? req.query.token : "";
  if ((bearer && bearer === expected) || (queryToken && queryToken === expected)) {
    return next();
  }
  return res.status(401).json({ error: "Não autorizado" });
}

export function validateStreamSessionToken(token) {
  if (!token) return false;
  try {
    return token === getSessionTokenFromEnv();
  } catch {
    return false;
  }
}
