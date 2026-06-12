/** Duração máxima aceita nos comandos de figurinha (30s). */
export const STICKER_DURATION_MAX_MS = 30_000;

/**
 * Converte arg opcional de duração em milissegundos.
 * Aceita: 5000, 5000ms, 5s, 5sec, 5.5s
 * @returns {number|null} ms ou null se vazio/inválido
 */
export function parseStickerDurationMs(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  let m = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(s);
  if (m) {
    const ms = Math.round(Number(m[1]));
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, STICKER_DURATION_MAX_MS) : null;
  }

  m = /^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/i.exec(s);
  if (m) {
    const ms = Math.round(Number(m[1]) * 1000);
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, STICKER_DURATION_MAX_MS) : null;
  }

  m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) {
    const ms = Math.round(Number(m[1]));
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, STICKER_DURATION_MAX_MS) : null;
  }

  return null;
}

/**
 * Resolve o primeiro arg de duração dos comandos de sticker.
 * @returns {{ maxDurationMs?: number, error?: string }}
 */
export function resolveStickerDurationArg(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return {};
  }
  const parsed = parseStickerDurationMs(raw);
  if (parsed === null) {
    return {
      error: `Duracao invalida: "${raw}". Use 5000, 5000ms ou 5s (max ${STICKER_DURATION_MAX_MS / 1000}s).`
    };
  }
  return { maxDurationMs: parsed };
}
