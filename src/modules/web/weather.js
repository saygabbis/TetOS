/**
 * Clima de verdade (Open-Meteo, grátis e sem chave) para "vai chover?", "tá frio aí?", "como tá o tempo em X".
 * Sem cidade na pergunta → São Paulo (onde a Teto mora).
 */

const DEFAULT_CITY = "São Paulo";
const CACHE_MS = 20 * 60_000;

const WMO = {
  0: "céu limpo", 1: "quase limpo", 2: "parcialmente nublado", 3: "nublado", 45: "neblina", 48: "neblina",
  51: "garoa fraca", 53: "garoa", 55: "garoa forte", 61: "chuva fraca", 63: "chuva", 65: "chuva forte",
  66: "chuva congelante", 67: "chuva congelante", 71: "neve fraca", 73: "neve", 75: "neve forte", 80: "pancadas de chuva",
  81: "pancadas de chuva", 82: "temporal", 95: "trovoada", 96: "trovoada com granizo", 99: "trovoada com granizo"
};

const WEATHER_RE = /\b(clima|previs[aã]o do tempo|como (t[aá]|est[aá]) o tempo|vai chover|t[aá] chovendo|chuva|temperatura|quantos graus|t[aá] (frio|calor|quente)|faz (frio|calor)|esfriar|esquentar)\b/i;

/** Pergunta sobre o tempo? Devolve a cidade citada (ou null = padrão). */
export function detectWeatherQuestion(text = "") {
  const t = String(text ?? "");
  if (!WEATHER_RE.test(t)) return null;
  // "tempo" sozinho é ambíguo ("faz tempo"), por isso a regex exige expressão de clima.
  const m = t.match(/\b(?:em|no|na|de|pra|para)\s+((?:[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\p{L}'-]+)(?:\s+(?:do|da|de|dos|das)?\s*[A-ZÁÉÍÓÚÂÊÔÃÕÇ][\p{L}'-]+){0,3})/u);
  return { city: m ? m[1].trim() : null, tomorrow: /\bamanh[aã](?!\p{L})/iu.test(t) };
}

export class WeatherService {
  constructor({ timeoutMs = 6000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async forecast(city = DEFAULT_CITY) {
    const key = city.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt`, { signal: AbortSignal.timeout(this.timeoutMs) })).json();
    const place = geo?.results?.[0];
    if (!place) return null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2`;
    const w = await (await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) })).json();
    const value = {
      place: [place.name, place.admin1, place.country_code !== "BR" ? place.country : null].filter(Boolean).join(", "),
      now: { temp: Math.round(w.current?.temperature_2m), feels: Math.round(w.current?.apparent_temperature), sky: WMO[w.current?.weather_code] ?? "—", rain: w.current?.precipitation ?? 0 },
      days: (w.daily?.time ?? []).map((d, i) => ({
        date: d,
        max: Math.round(w.daily.temperature_2m_max[i]),
        min: Math.round(w.daily.temperature_2m_min[i]),
        rainChance: w.daily.precipitation_probability_max?.[i] ?? null,
        sky: WMO[w.daily.weather_code[i]] ?? "—"
      }))
    };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

export function formatWeatherForPrompt(f, { tomorrow = false } = {}) {
  if (!f) return null;
  const [today, next] = f.days;
  const lines = [
    `[CLIMA — ${f.place}, dados reais de agora]`,
    `Agora: ${f.now.temp}°C (sensação ${f.now.feels}°C), ${f.now.sky}${f.now.rain > 0 ? ", chovendo" : ""}.`,
    today ? `Hoje: ${today.min}–${today.max}°C, ${today.sky}${today.rainChance != null ? `, ${today.rainChance}% de chance de chuva` : ""}.` : null,
    next ? `Amanhã: ${next.min}–${next.max}°C, ${next.sky}${next.rainChance != null ? `, ${next.rainChance}% de chance de chuva` : ""}.` : null,
    `Responda com isso de forma natural (como amiga que olhou o app do tempo${tomorrow ? ", focando em amanhã" : ""}) — não liste tudo.`
  ];
  return lines.filter(Boolean).join("\n");
}
