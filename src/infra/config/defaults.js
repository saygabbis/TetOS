const ollamaModeRaw = (process.env.TETOS_OLLAMA_MODE ?? "local").toLowerCase();
const ollamaMode = ollamaModeRaw === "cloud" ? "cloud" : "local";

const ollamaBaseUrl =
  ollamaMode === "cloud"
    ? (process.env.TETOS_OLLAMA_CLOUD_URL ?? "https://ollama.com")
    : (process.env.TETOS_OLLAMA_URL ?? "http://localhost:11434");

const model =
  process.env.TETOS_MODEL ??
  (ollamaMode === "cloud" ? "minimax-m2.7:cloud" : "llama3");

const ollamaApiKey =
  process.env.TETOS_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY ?? "";

export const DEFAULTS = {
  ollamaMode,
  model,
  ollamaBaseUrl,
  ollamaApiKey,
  memoryPath: process.env.TETOS_MEMORY_PATH ?? "./data/memory.json",
  maxShortTerm: Number(process.env.TETOS_MAX_SHORT ?? 8),
  port: Number(process.env.TETOS_PORT ?? 3000),
  personalityPath: process.env.TETOS_PERSONALITY_PATH ?? "./data/personality.json",
  maxHistory: Number(process.env.TETOS_MAX_HISTORY ?? 12),
  maxContentLength: Number(process.env.TETOS_MAX_CONTENT ?? 2000),
  maxIdLength: Number(process.env.TETOS_MAX_ID ?? 64),
  maxTags: Number(process.env.TETOS_MAX_TAGS ?? 10),
  responseHistoryLimit: Number(process.env.TETOS_RESPONSE_HISTORY ?? 5),
  responseSimilarity: Number(process.env.TETOS_RESPONSE_SIMILARITY ?? 0.75),
  responseMaxParts: Number(process.env.TETOS_RESPONSE_MAX_PARTS ?? 4),
  whatsappEnabled: String(process.env.WHATSAPP_ENABLED ?? "false").toLowerCase() === "true",
  whatsappSessionPath: process.env.WHATSAPP_SESSION_PATH ?? "./data/session",
  whatsappAutoConnect: String(process.env.WHATSAPP_AUTO_CONNECT ?? "true").toLowerCase() === "true",
  presenceEnabled: String(process.env.PRESENCE_ENABLED ?? "true").toLowerCase() === "true",
  presenceCheckMs: Number(process.env.PRESENCE_CHECK_MS ?? 60000),
  presenceMinCooldownMs: Number(process.env.PRESENCE_MIN_COOLDOWN_MS ?? 1800000),
  presenceMaxCooldownMs: Number(process.env.PRESENCE_MAX_COOLDOWN_MS ?? 7200000),
  presenceMaxDailyPerUser: Number(process.env.PRESENCE_MAX_DAILY_PER_USER ?? 3),
  presenceInactiveMs: Number(process.env.PRESENCE_INACTIVE_MS ?? 600000)
};
