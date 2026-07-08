import { detectTetoNameCall } from "../../integrations/whatsapp/tetoNameDetect.js";

const WAKE_WORD_RE =
  /\b(acorda|acordar|acordaaa+|acordem|desperta|despertar|levanta|levantar|wake\s*up|me\s+deixa\s+dormir|para\s+de\s+dormir)\b/i;

/**
 * Score 0–1: quão forte é a tentativa de acordar a Teto no meio do sono.
 */
export function scoreSleepDisturbance(text = "", { floodCount = 0 } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return 0;

  let score = 0;
  const nameCall = detectTetoNameCall(raw);
  if (nameCall.detected) score += nameCall.confidence * 0.42;

  const letters = raw.replace(/\s/g, "");
  const upper = (raw.match(/[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/g) ?? []).length;
  const capsRatio = letters.length ? upper / letters.length : 0;
  if (capsRatio >= 0.55 && raw.length >= 5) score += 0.28;
  if (/[A-ZÁÉÍÓÚÂÊÔÃÕÇ]{6,}/.test(raw)) score += 0.18;

  if (WAKE_WORD_RE.test(raw)) score += 0.34;
  if (/\b(teto|tetoooo+|teeeto+)\b/i.test(raw) && capsRatio > 0.4) score += 0.15;

  if (floodCount >= 3) score += 0.22;
  if (floodCount >= 5) score += 0.18;
  if (floodCount >= 8) score += 0.12;

  return Math.min(1, score);
}

export function isSleepDisturbanceEnabled() {
  return String(process.env.TETOS_SLEEP_DISTURBANCE_ENABLED ?? "true").toLowerCase() !== "false";
}

export function sleepDisturbanceThreshold() {
  const n = Number(process.env.TETOS_SLEEP_DISTURBANCE_THRESHOLD ?? 0.68);
  return Number.isFinite(n) ? n : 0.68;
}

export function sleepTempWakeMs() {
  const n = Number(process.env.TETOS_SLEEP_TEMP_WAKE_MS ?? 240_000);
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : 240_000;
}

export function sleepDisturbanceFloodWindowMs() {
  const n = Number(process.env.TETOS_SLEEP_DISTURBANCE_FLOOD_WINDOW_MS ?? 90_000);
  return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : 90_000;
}
