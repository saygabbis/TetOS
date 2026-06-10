const llmProviderRaw = (process.env.TETOS_LLM_PROVIDER ?? "ollama").toLowerCase();
const llmProvider = llmProviderRaw === "minimax" ? "minimax" : "ollama";

const ollamaModeRaw = (process.env.TETOS_OLLAMA_MODE ?? "local").toLowerCase();
const ollamaMode = ollamaModeRaw === "cloud" ? "cloud" : "local";

const ollamaBaseUrl =
  ollamaMode === "cloud"
    ? (process.env.TETOS_OLLAMA_CLOUD_URL ?? "https://ollama.com")
    : (process.env.TETOS_OLLAMA_URL ?? "http://localhost:11434");

const model =
  process.env.TETOS_MODEL ??
  (llmProvider === "minimax"
    ? (process.env.TETOS_MINIMAX_MODEL ?? "MiniMax-M2.7")
    : ollamaMode === "cloud"
      ? "minimax-m2.7:cloud"
      : "llama3");

const minimaxApiKey = process.env.TETOS_MINIMAX_API_KEY ?? "";
const minimaxBaseUrl = process.env.TETOS_MINIMAX_BASE_URL ?? "https://api.minimax.io";
const minimaxModel = process.env.TETOS_MINIMAX_MODEL ?? "MiniMax-M2.7";
const minimaxWorkerModel =
  process.env.TETOS_MINIMAX_WORKER_MODEL ?? "MiniMax-M2.7-highspeed";

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

/** gpt-oss e modelos cloud de raciocínio estouram num_predict=400 só no "thinking". */
const modelLower = String(model).toLowerCase();
if (
  rawNumPredict === undefined &&
  ollamaNumPredict === 400 &&
  (modelLower.includes("gpt-oss") || modelLower.includes("deepseek-r1"))
) {
  ollamaNumPredict = 2000;
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
  llmProvider,
  minimaxApiKey,
  minimaxBaseUrl,
  minimaxModel,
  minimaxWorkerModel,
  ollamaMode,
  model,
  ollamaBaseUrl,
  ollamaApiKey,
  ollamaTemperature,
  /** @type {number | null} null = sem limite (pode ser mais lento em respostas longas) */
  ollamaNumPredict,
  memoryPath: process.env.TETOS_MEMORY_PATH ?? "./data/memory.json",
  shortTermPath: process.env.TETOS_SHORT_TERM_PATH ?? "./data/short-term",
  maxShortTerm: Number(process.env.TETOS_MAX_SHORT ?? 24),
  port: Number(process.env.TETOS_PORT ?? 6453),
  personalityPath: process.env.TETOS_PERSONALITY_PATH ?? "./data/personality.json",
  characterPath: process.env.TETOS_CHARACTER_PATH ?? "./data/character.json",
  maxHistory: Number(process.env.TETOS_MAX_HISTORY ?? 24),
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
  /** Limite em MB para mídia “quente” (exceto `_archive`); acima disso remove LRU e arquiva thumbs de aprendizado. */
  mediaRetentionEnabled: String(process.env.TETOS_MEDIA_RETENTION_ENABLED ?? "true").toLowerCase() === "true",
  mediaHotMaxBytes: (() => {
    const mb = Number(process.env.TETOS_MEDIA_HOT_MAX_MB ?? "100");
    if (!Number.isFinite(mb) || mb < 10 || mb > 2048) return 100 * 1024 * 1024;
    return Math.floor(mb * 1024 * 1024);
  })(),
  mediaRetentionIntervalMs: (() => {
    const ms = Number(process.env.TETOS_MEDIA_RETENTION_INTERVAL_MS ?? "900000");
    if (!Number.isFinite(ms) || ms < 60000) return 900000;
    return Math.floor(ms);
  })(),
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
  /**
   * single = uma sessão (chat + comandos de mídia).
   * dual | multi | split = duas sessões no mesmo processo: principal (aprendizado/chat) + secundária (só .sticker/.toimg).
   */
  whatsappMode: (() => {
    const raw = String(process.env.WHATSAPP_MODE ?? "single").trim().toLowerCase();
    if (raw === "dual" || raw === "multi" || raw === "split" || raw === "session-media") {
      return "dual";
    }
    return "single";
  })(),
  /** dual: sessão principal só aprende/observa; sessão secundária (bot) responde como Teto. */
  whatsappMainObserveOnly:
    String(process.env.WHATSAPP_MAIN_OBSERVE_ONLY ?? "true").toLowerCase() === "true",
  /** Pasta Baileys do número usado só para comandos de figurinha (apenas WHATSAPP_MODE=dual). */
  whatsappMediaSessionPath: process.env.WHATSAPP_MEDIA_SESSION_PATH ?? "./data/session-media",
  /** dual + sessão principal: texto opcional quando alguém manda comando de figurinha no número errado (vazio = só ignora). */
  whatsappStickerCommandsDisabledHint:
    process.env.WHATSAPP_STICKER_COMMANDS_DISABLED_HINT ??
    process.env.WHATSAPP_STICKER_DISABLED_HINT ??
    "",
  whatsappSessionPath: process.env.WHATSAPP_SESSION_PATH ?? "./data/session",
  /** false = Baileys recebe mensagens com mais estabilidade (linked device). */
  whatsappMarkOnlineOnConnect:
    String(process.env.WHATSAPP_MARK_ONLINE_ON_CONNECT ?? "false").toLowerCase() === "true",
  whatsappAutoConnect: String(process.env.WHATSAPP_AUTO_CONNECT ?? "true").toLowerCase() === "true",
  learningModeEnabled: String(process.env.LEARNING_MODE_ENABLED ?? "false").toLowerCase() === "true",
  replyEnabled: String(process.env.REPLY_ENABLED ?? "true").toLowerCase() === "true",
  thinkingLogsEnabled: String(process.env.THINKING_LOGS_ENABLED ?? "true").toLowerCase() === "true",
  commandPrefix: process.env.COMMAND_PREFIX ?? ".",
  commandMediaHistoryLimit: Number(process.env.COMMAND_MEDIA_HISTORY_LIMIT ?? 30),
  commandMediaDerivedPath: process.env.COMMAND_MEDIA_DERIVED_PATH ?? "./data/media/derived",
  /**
   * Teto em KiB para figurinha no WhatsApp (≈1 MiB no cliente; abaixo disso costuma renderizar bem).
   * Comandos .sticker reencodificam com qualidade/resolução menores até caber (animado e estático lossy).
   * TETOS_STICKER_MAX_KB em KiB (ex.: 950). Default 950 KiB ≈ 973000 bytes.
   */
  tetosStickerMaxBytes: (() => {
    const raw = process.env.TETOS_STICKER_MAX_KB;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      const kb = Number(String(raw).trim());
      if (Number.isFinite(kb) && kb >= 64 && kb <= 1024) return Math.floor(kb * 1024);
    }
    return 950 * 1024;
  })(),
  dailyReportEnabled: String(process.env.DAILY_REPORT_ENABLED ?? "false").toLowerCase() === "true",
  dailyReportTime: process.env.DAILY_REPORT_TIME ?? "00:00",
  dailyReportTz: process.env.DAILY_REPORT_TZ ?? "America/Sao_Paulo",
  thirdPartyAnonymization: process.env.THIRD_PARTY_ANONYMIZATION ?? "strong",
  /** Telefone da dona — admin, ledger e relatórios (memória de chat usa dm-LID como todos). */
  learningTargetUserId: process.env.LEARNING_TARGET_USER_ID ?? "",
  /** JID/LID do PV da dona com a Teto — reconhece owner sem virar perfil padrão. */
  ownerWaJids: (process.env.TETOS_OWNER_WA_JID ?? process.env.TETOS_OWNER_WA_JIDS ?? "")
    .split(/[,;]/)
    .map((item) => item.trim().toLowerCase().split(":")[0])
    .filter(Boolean),
  learningLedgerPath: process.env.LEARNING_LEDGER_PATH ?? "./data/learning-ledger",
  learningFocusPath: process.env.LEARNING_FOCUS_PATH ?? "./data/learningFocus.json",
  behaviorProfilesPath: process.env.BEHAVIOR_PROFILES_PATH ?? "./data/behaviorProfiles.json",
  dailyReportsPath: process.env.DAILY_REPORTS_PATH ?? "./data/reports/daily",
  presenceEnabled: String(process.env.PRESENCE_ENABLED ?? "true").toLowerCase() === "true",
  presenceCheckMs: Number(process.env.PRESENCE_CHECK_MS ?? 120000),
  presenceMinCooldownMs: Number(process.env.PRESENCE_MIN_COOLDOWN_MS ?? 2700000),
  presenceMaxCooldownMs: Number(process.env.PRESENCE_MAX_COOLDOWN_MS ?? 14400000),
  presenceMaxDailyPerUser: Number(process.env.PRESENCE_MAX_DAILY_PER_USER ?? 2),
  presenceInactiveMs: Number(process.env.PRESENCE_INACTIVE_MS ?? 2700000),
  initiationChance: Number(process.env.TETOS_INITIATION_CHANCE ?? 0.22),
  initiationQueuePath: process.env.TETOS_INITIATION_QUEUE_PATH ?? "./data/initiationQueue.json",
  brainEnabled: String(process.env.TETOS_BRAIN_ENABLED ?? "true").toLowerCase() === "true",
  lifeProfilePath: process.env.TETOS_LIFE_PATH ?? "./data/tetoLife.json",
  lifeStatePath: process.env.TETOS_LIFE_STATE_PATH ?? "./data/lifeState.json",
  lifeJournalPath: process.env.TETOS_LIFE_JOURNAL_PATH ?? "./data/lifeJournal.ndjson",
  autonomousStatePath: process.env.TETOS_AUTONOMOUS_STATE_PATH ?? "./data/autonomousState.json",
  emotionStatePath: process.env.TETOS_EMOTION_STATE_PATH ?? "./data/emotionState.json",
  bodyNeedsPath: process.env.TETOS_BODY_NEEDS_PATH ?? "./data/bodyNeeds.json",
  healthStatePath: process.env.TETOS_HEALTH_STATE_PATH ?? "./data/healthState.json",
  socialGraphPath: process.env.TETOS_SOCIAL_GRAPH_PATH ?? "./data/socialGraph.json",
  trustBondsPath: process.env.TETOS_TRUST_BONDS_PATH ?? "./data/trustBonds.json",
  worldContextPath: process.env.TETOS_WORLD_CONTEXT_PATH ?? "./data/worldContext.json",
  musicStatePath: process.env.TETOS_MUSIC_STATE_PATH ?? "./data/musicState.json",
  musicDiscographyPath: process.env.TETOS_MUSIC_DISCOGRAPHY_PATH ?? "./data/tetoDiscography.json",
  absorbedPatternsPath: process.env.TETOS_ABSORBED_PATTERNS_PATH ?? "./data/absorbedPatterns.json",
  groupMemoryPath: process.env.TETOS_GROUP_MEMORY_PATH ?? "./data/groupMemory.ndjson",
  groupMemoryMaxEntries: Number(process.env.TETOS_GROUP_MEMORY_MAX_ENTRIES ?? 500),
  episodicMemoryPath: process.env.TETOS_MEMORY_EPISODIC_PATH ?? "./data/episodicMemory.ndjson",
  mindLogPath: process.env.TETOS_MIND_LOG_PATH ?? "./data/mind-log",
  mindLogEnabled: String(process.env.TETOS_MIND_LOG_ENABLED ?? "true").toLowerCase() === "true",
  /** slim = snapshot leve (VPS 24/7); full = dump completo (debug). */
  mindLogMode: String(process.env.TETOS_MIND_LOG_MODE ?? "slim").trim().toLowerCase() === "full" ? "full" : "slim",
  /** Grava mind log só quando a Teto respondeu (menos ruído). */
  mindLogOnlyReplies: String(process.env.TETOS_MIND_LOG_ONLY_REPLIES ?? "true").toLowerCase() === "true",
  mindLogRetentionDays: Number(process.env.TETOS_MIND_LOG_RETENTION_DAYS ?? 14),
  mediaLearningPath: process.env.TETOS_MEDIA_LEARNING_PATH ?? "./data/mediaLearning.json",
  timingEngineEnabled: String(process.env.TETOS_TIMING_ENGINE_ENABLED ?? "true").toLowerCase() === "true",
  brainBackgroundTickMs: Number(process.env.TETOS_BRAIN_BACKGROUND_TICK_MS ?? 120000),
  soloThoughtIntervalMs: Number(process.env.TETOS_SOLO_THOUGHT_INTERVAL_MS ?? 300000),
  musicResearchIntervalMs: Number(process.env.TETOS_MUSIC_RESEARCH_INTERVAL_MS ?? 86400000),
  workerLlmModel: process.env.TETOS_WORKER_LLM_MODEL ?? "",
  workerLlmUrl: process.env.TETOS_WORKER_LLM_URL ?? "",
  memoryDecayEnabled: String(process.env.TETOS_MEMORY_DECAY_ENABLED ?? "true").toLowerCase() === "true",
  batchWindowMs: Number(process.env.TETOS_BATCH_WINDOW_MS ?? 1200),
  groupBatchWindowMs: Number(process.env.TETOS_GROUP_BATCH_WINDOW_MS ?? 2200),
  maxParallelGenerations: Number(process.env.TETOS_MAX_PARALLEL_GENERATIONS ?? 3),
  maxQueueCoalesce: Number(process.env.TETOS_MAX_QUEUE_COALESCE ?? 6),
  /** Após menção/resposta em grupo, segue respondendo o mesmo usuário sem @ (ms). Padrão 2 min. */
  groupEngagementMs: Number(process.env.TETOS_GROUP_ENGAGEMENT_MS ?? 120000),
  multimodalMaxPerScope: Number(process.env.TETOS_MULTIMODAL_MAX_PER_SCOPE ?? 12),
  visualAnalysesMaxPerScope: Number(process.env.TETOS_VISUAL_MAX_PER_SCOPE ?? 10),
  typingGraceMs: Number(process.env.TETOS_TYPING_GRACE_MS ?? 2400),
  typingMinDelayMs: Number(process.env.TETOS_TYPING_MIN_DELAY_MS ?? 140),
  typingMaxDelayMs: Number(process.env.TETOS_TYPING_MAX_DELAY_MS ?? 2400),
  modelTimeoutMs: Number(process.env.TETOS_MODEL_TIMEOUT_MS ?? 25000),
  visionAdapter: process.env.TETOS_VISION_ADAPTER ?? "blip",
  videoAdapter: process.env.TETOS_VIDEO_ADAPTER ?? "ffmpeg_frames",
  webReaderEnabled: String(process.env.TETOS_WEB_READER_ENABLED ?? "true").toLowerCase() === "true",
  /** false = responde a qualquer contato (comportamento atual); true = só /teto-ativar e /teto-grupo-ativar */
  tetoActivationRequired: String(process.env.TETOS_ACTIVATION_REQUIRED ?? "false").toLowerCase() === "true",
  tetoActivationPath: process.env.TETOS_ACTIVATION_PATH ?? "./data/tetoActivations.json"
};
