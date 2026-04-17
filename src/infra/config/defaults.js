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

const ollamaTempEnv = process.env.TETOS_OLLAMA_TEMPERATURE;
const parsedTemp =
  ollamaTempEnv !== undefined && String(ollamaTempEnv).trim() !== ""
    ? Number(ollamaTempEnv)
    : NaN;
const ollamaTemperature = Number.isFinite(parsedTemp) ? parsedTemp : 0.65;

/** Limite de tokens gerados — respostas de chat ficam mais rápidas; 0 ou unlimited = sem teto. */
const rawNumPredict = process.env.TETOS_OLLAMA_NUM_PREDICT;
let ollamaNumPredict = 400;
if (rawNumPredict !== undefined && rawNumPredict !== null && String(rawNumPredict).trim() !== "") {
  const s = String(rawNumPredict).trim();
  if (/^unlimited$/i.test(s) || s === "0") {
    ollamaNumPredict = null;
  } else {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
      ollamaNumPredict = Math.floor(n);
    }
  }
}

const rawResponseMaxParts = process.env.TETOS_RESPONSE_MAX_PARTS;
const trimmedResponseMaxParts =
  rawResponseMaxParts !== undefined && rawResponseMaxParts !== null
    ? String(rawResponseMaxParts).trim()
    : "";
const parsedResponseMaxParts = trimmedResponseMaxParts ? Number(trimmedResponseMaxParts) : NaN;
/** Sem limite artificial: só divide pelo texto. Use env com inteiro ≥1 se quiser teto opcional. */
const responseMaxParts =
  !trimmedResponseMaxParts || /^unlimited$/i.test(trimmedResponseMaxParts)
    ? Infinity
    : Number.isFinite(parsedResponseMaxParts) && parsedResponseMaxParts > 0
      ? Math.floor(parsedResponseMaxParts)
      : Infinity;

export const DEFAULTS = {
  ollamaMode,
  model,
  ollamaBaseUrl,
  ollamaApiKey,
  ollamaTemperature,
  /** @type {number | null} null = sem limite (pode ser mais lento em respostas longas) */
  ollamaNumPredict,
  memoryPath: process.env.TETOS_MEMORY_PATH ?? "./data/memory.json",
  maxShortTerm: Number(process.env.TETOS_MAX_SHORT ?? 8),
  port: Number(process.env.TETOS_PORT ?? 6453),
  personalityPath: process.env.TETOS_PERSONALITY_PATH ?? "./data/personality.json",
  characterPath: process.env.TETOS_CHARACTER_PATH ?? "./data/character.json",
  maxHistory: Number(process.env.TETOS_MAX_HISTORY ?? 12),
  maxContentLength: Number(process.env.TETOS_MAX_CONTENT ?? 2000),
  maxIdLength: Number(process.env.TETOS_MAX_ID ?? 64),
  maxTags: Number(process.env.TETOS_MAX_TAGS ?? 10),
  responseHistoryLimit: Number(process.env.TETOS_RESPONSE_HISTORY ?? 5),
  responseSimilarity: Number(process.env.TETOS_RESPONSE_SIMILARITY ?? 0.75),
  responseMaxParts,
  statePath: process.env.TETOS_STATE_PATH ?? "./data/state.json",
  timePath: process.env.TETOS_TIME_PATH ?? "./data/time.json",
  userPatternsPath: process.env.TETOS_USER_PATTERNS_PATH ?? "./data/userPatterns.json",
  selectiveMemoryPath: process.env.TETOS_SELECTIVE_MEMORY_PATH ?? "./data/selectiveMemory.json",
  channelRegistryPath: process.env.TETOS_CHANNEL_REGISTRY_PATH ?? "./data/channels.json",
  selectiveMemoryCapacity: Number(process.env.TETOS_SELECTIVE_MEMORY_CAPACITY ?? 12),
  selectiveMemoryExpirationMs: Number(process.env.TETOS_SELECTIVE_MEMORY_EXPIRATION_MS ?? 21600000),
  selectiveMemoryReinforcementThreshold: Number(process.env.TETOS_SELECTIVE_MEMORY_REINFORCEMENT_THRESHOLD ?? 3),
  groupPassiveSize: Number(process.env.TETOS_GROUP_PASSIVE_SIZE ?? 4),
  searchEnabled: String(process.env.TETOS_SEARCH_ENABLED ?? "true").toLowerCase() === "true",
  searchMaxResults: Number(process.env.TETOS_SEARCH_MAX_RESULTS ?? 5),
  adminUserId: process.env.TETOS_ADMIN_USER_ID ?? process.env.ADMIN_USER_ID ?? "",
  logPath: process.env.TETOS_LOG_PATH ?? "./data/logs/tetos.log",
  whatsappMediaPath: process.env.TETOS_WHATSAPP_MEDIA_PATH ?? "./data/media",
  audioTranscriptionsPath: process.env.TETOS_AUDIO_TRANSCRIPTIONS_PATH ?? "./data/audioTranscriptions.json",
  visualAnalysesPath: process.env.TETOS_VISUAL_ANALYSES_PATH ?? "./data/visualAnalyses.json",
  documentsPath: process.env.TETOS_DOCUMENTS_PATH ?? "./data/documents",
  metricsPath: process.env.TETOS_METRICS_PATH ?? "./data/metrics.json",
  pendingConfirmationsPath: process.env.TETOS_PENDING_CONFIRMATIONS_PATH ?? "./data/pendingConfirmations.json",
  stickersPath: process.env.TETOS_STICKERS_PATH ?? "./data/stickers",
  remindersPath: process.env.TETOS_REMINDERS_PATH ?? "./data/reminders.json",
  multimodalMemoryPath: process.env.TETOS_MULTIMODAL_MEMORY_PATH ?? "./data/multimodalMemory.json",
  reminderSweepMs: Number(process.env.TETOS_REMINDER_SWEEP_MS ?? 60000),
  reminderMaxDeliveryAttempts: Number(process.env.TETOS_REMINDER_MAX_DELIVERY_ATTEMPTS ?? 5),
  reminderDeliveryRetryMs: Number(process.env.TETOS_REMINDER_DELIVERY_RETRY_MS ?? 300000),
  stickerOnlyChance: Number(process.env.TETOS_STICKER_ONLY_CHANCE ?? 0.35),
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
