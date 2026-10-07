const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

function parseAllowedOrigins() {
  const raw = process.env.TETOS_UI_ALLOWED_ORIGINS?.trim();
  if (!raw) return new Set(DEFAULT_ORIGINS);
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(list);
}

/**
 * CORS para o app desktop (Vite/Electron) chamar /ui/* com Authorization.
 */
export function attachUiCors(app) {
  const allowed = parseAllowedOrigins();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowOrigin =
      !origin || allowed.has(origin) || origin === "null" ? origin || "*" : null;

    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, X-File-Name",
      );
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
    return next();
  });
}

export function getDefaultUiOrigins() {
  return DEFAULT_ORIGINS;
}
