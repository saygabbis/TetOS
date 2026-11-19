import { DEFAULTS } from "../infra/config/defaults.js";
import { ownerIdentityIds } from "../core/channels/userActivity.js";
import { ShortTermMemory } from "../core/memory/shortTerm.js";
import { LongTermMemory } from "../core/memory/longTerm.js";
import { ContextBuilder } from "../core/memory/contextBuilder.js";
import { SelectiveMemoryStore } from "../core/memory/selectiveMemory.js";
import { GroupMemoryStore } from "../core/memory/GroupMemoryStore.js";
import { EpisodicMemoryStore } from "../core/memory/EpisodicMemoryStore.js";
import { OllamaClient } from "../core/brain/ollamaClient.js";
import { OllamaKeyPool } from "../core/brain/ollamaKeyPool.js";
import { MiniMaxClient } from "../core/brain/minimaxClient.js";
import { OpenAIClient } from "../core/brain/openaiClient.js";
import { OpenAIUsageMeter } from "../core/brain/openaiUsage.js";
import { BrainOrchestrator } from "../core/brain/BrainOrchestrator.js";
import { Agent } from "../core/agent/agent.js";
import { ChatService } from "../modules/chat/chatService.js";
import { ResponseProcessorPool } from "../modules/chat/responseProcessorPool.js";
import { InternalState } from "../core/state/internalState.js";
import { TimeStore } from "../core/time/timeStore.js";
import { UserPatternsStore } from "../core/time/userPatternsStore.js";
import { ChannelRegistry } from "../core/channels/channelRegistry.js";
import { GroupEngagementWindow } from "../core/channels/groupEngagementWindow.js";
import { ChannelAdminService } from "../core/channels/channelAdmin.js";
import { TetoActivationStore } from "../core/channels/TetoActivationStore.js";
import { StickerRepertoireModeStore } from "../integrations/whatsapp/media/stickerRepertoireModeStore.js";
import { ViewOnceMirrorStore } from "../integrations/whatsapp/media/viewOnceMirrorStore.js";
import { ViewOnceMirrorService } from "../integrations/whatsapp/media/viewOnceMirrorService.js";
import { DeferredInbox } from "../integrations/whatsapp/conversation/deferredInbox.js";
import { IdentityLinkStore } from "../core/identity/identityLinks.js";
import { AttentionFocus } from "../core/presence/attentionFocus.js";
import { SummonWindow } from "../core/presence/summonWindow.js";
import { VisualKnowledgeStore } from "../core/media/visualKnowledgeStore.js";
import { runMessagePipeline } from "../core/pipeline/messagePipeline.js";
import { SearchAdapter } from "../modules/web/searchAdapter.js";
import { ConvenusClient } from "../core/media/convenusClient.js";
import { SearchModule } from "../modules/web/searchModule.js";
import { DocumentStore } from "../modules/documents/documentStore.js";
import { DocumentWriter } from "../modules/documents/documentWriter.js";
import { DocumentModule } from "../modules/documents/documentModule.js";
import { OperationRouter } from "../core/operations/operationRouter.js";
import { ChatCommandRouter } from "../core/operations/chatCommandRouter.js";
import { PendingConfirmationStore } from "../core/operations/pendingConfirmations.js";
import { ReminderStore } from "../modules/reminders/reminderStore.js";
import { ReminderScheduler } from "../modules/reminders/reminderScheduler.js";
import { PriceWatch } from "../modules/priceWatch/priceWatch.js";
import { PriceSources } from "../modules/priceWatch/priceSources.js";
import { MultimodalMemoryStore } from "../core/memory/multimodalMemory.js";
import { AudioTranscriptionStore } from "../modules/audio/audioTranscriptionStore.js";
import { AudioTranscriber } from "../modules/audio/audioTranscriber.js";
import { ImageGenerationService } from "../core/media/imageGenerationService.js";
import { VisualAnalysisStore } from "../modules/vision/visualAnalysisStore.js";
import { VisualAnalyzer } from "../modules/vision/visualAnalyzer.js";
import { SemanticVisionAnalyzer } from "../modules/vision/semanticVisionAnalyzer.js";
import { OllamaVisionAnalyzer } from "../modules/vision/ollamaVisionAnalyzer.js";
import { LinkReader } from "../modules/web/linkReader.js";
import { WeatherService } from "../modules/web/weather.js";
import { AutomateApiClient } from "../integrations/automate/automateApiClient.js";
import { PeopleMemory } from "../core/memory/peopleMemory.js";
import { InitiativeState } from "../core/autonomy/initiative.js";
import { VoiceNotes } from "../modules/voice/voiceNotes.js";
import { Logger } from "../infra/observability/logger.js";
import { MetricsStore } from "../infra/observability/metricsStore.js";
import { loadCharacter, loadPersonality } from "../core/personality/index.js";
import { PrivacyAnonymizer } from "../core/privacy/anonymizer.js";
import { Mind } from "../core/mind/mind.js";
import { EvolutionEngine } from "../core/evolution/evolutionEngine.js";
import { OverlayStore } from "../core/evolution/overlayStore.js";
import { ChangeVerifier } from "../core/evolution/changeVerifier.js";
import { SkillManager } from "../core/evolution/skillManager.js";
import { publicFetch } from "../core/evolution/webTool.js";
import { enqueueOutbox } from "../integrations/whatsapp/conversation/outbox.js";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { EventLedger } from "../core/learning/eventLedger.js";
import { BehaviorProfiler } from "../core/learning/behaviorProfiler.js";
import { FocusConfigStore } from "../core/learning/focusConfigStore.js";
import { DailyReportGenerator } from "../core/learning/dailyReportGenerator.js";
import { RelationshipCommitmentStore } from "../core/social/RelationshipCommitmentStore.js";
import { repairProfileContamination } from "../core/channels/botIdentity.js";

let ollamaKeyPool = null;
/** Uma piscina só pra conversa, mente e visão: quando uma conta esgota, todas trocam juntas. */
function sharedOllamaKeyPool() {
  if (DEFAULTS.ollamaMode !== "cloud" || DEFAULTS.ollamaApiKeys.length < 2) return null;
  ollamaKeyPool ??= new OllamaKeyPool({ keys: DEFAULTS.ollamaApiKeys, statePath: DEFAULTS.ollamaKeyStatePath });
  return ollamaKeyPool;
}

let openaiUsage = null;
/** Um contador de gasto só pra tudo que usa a OpenAI (conversa, mente, visão, voz, imagem, busca). */
export function sharedOpenAIUsage() {
  openaiUsage ??= new OpenAIUsageMeter({
    path: DEFAULTS.openaiUsagePath,
    dailyBudgetUsd: DEFAULTS.openaiDailyBudgetUsd,
    timeZone: DEFAULTS.dailyReportTz ?? "America/Sao_Paulo"
  });
  return openaiUsage;
}

/** Nome de modelo que veio de config antiga da Ollama (gemma, llama…) não serve na OpenAI: usa o padrão. */
function openaiModelFor(model, fallback) {
  const m = String(model ?? "").trim();
  return /^(gpt-|o\d|chatgpt-)/i.test(m) ? m : fallback;
}

/**
 * kind: chat (conversa, nunca barrada pelo teto) | worker (fundo, barato) | code (autoevolução).
 */
function createOpenAIClient({ model, temperature, numPredict, kind = "chat", timeoutMs = DEFAULTS.modelTimeoutMs, purpose } = {}) {
  const fallback = kind === "chat" ? DEFAULTS.openaiModel : DEFAULTS.openaiWorkerModel;
  return new OpenAIClient({
    baseUrl: DEFAULTS.openaiBaseUrl,
    apiKey: DEFAULTS.openaiApiKey,
    model: openaiModelFor(model, fallback),
    temperature,
    numPredict,
    // Raciocínio conta como saída: dá mais tempo pra resposta não cortar.
    timeoutMs: Math.max(timeoutMs, kind === "chat" ? 45_000 : 90_000),
    reasoningEffort:
      kind === "chat" ? DEFAULTS.openaiReasoning : kind === "code" ? DEFAULTS.openaiCodeReasoning : DEFAULTS.openaiWorkerReasoning,
    serviceTier: kind === "chat" ? "" : DEFAULTS.openaiWorkerServiceTier,
    usage: sharedOpenAIUsage(),
    critical: kind === "chat",
    purpose: purpose ?? kind
  });
}

function createLlmClient({ model, temperature, numPredict, worker = false, timeoutMs = DEFAULTS.modelTimeoutMs, kind, purpose } = {}) {
  if (DEFAULTS.llmProvider === "openai") {
    return createOpenAIClient({ model, temperature, numPredict, timeoutMs, kind: kind ?? (worker ? "worker" : "chat"), purpose });
  }
  if (DEFAULTS.llmProvider === "minimax") {
    return new MiniMaxClient({
      baseUrl: DEFAULTS.minimaxBaseUrl,
      model: model ?? (worker ? DEFAULTS.minimaxWorkerModel : DEFAULTS.minimaxModel),
      apiKey: DEFAULTS.minimaxApiKey || undefined,
      temperature,
      numPredict,
      timeoutMs,
      thinking: worker ? { type: "disabled" } : { type: "disabled" }
    });
  }
  return new OllamaClient({
    baseUrl: DEFAULTS.ollamaBaseUrl,
    model: model ?? DEFAULTS.model,
    apiKey: DEFAULTS.ollamaApiKey || undefined,
    keyPool: sharedOllamaKeyPool(),
    temperature,
    numPredict,
    timeoutMs
  });
}

export function createRuntime() {
  if (DEFAULTS.llmProvider === "openai") {
    if (!DEFAULTS.openaiApiKey) {
      throw new Error(
        "TETOS_LLM_PROVIDER=openai requer TETOS_OPENAI_API_KEY no .env. Crie uma chave em https://platform.openai.com/api-keys"
      );
    }
  } else if (DEFAULTS.llmProvider === "minimax") {
    if (!DEFAULTS.minimaxApiKey) {
      throw new Error(
        "TETOS_LLM_PROVIDER=minimax requer TETOS_MINIMAX_API_KEY. Crie uma chave em https://platform.minimax.io"
      );
    }
  } else if (DEFAULTS.ollamaMode === "cloud" && !DEFAULTS.ollamaApiKey) {
    throw new Error(
      "TETOS_OLLAMA_MODE=cloud requer TETOS_OLLAMA_API_KEY (ou OLLAMA_API_KEY). Crie uma chave em https://ollama.com/settings/keys"
    );
  }

  const shortTerm = new ShortTermMemory(DEFAULTS.maxShortTerm, {
    persistPath: DEFAULTS.shortTermPath
  });
  const longTerm = new LongTermMemory(DEFAULTS.memoryPath);
  repairProfileContamination({ longTerm, defaults: DEFAULTS });
  const groupMemory = new GroupMemoryStore(DEFAULTS.groupMemoryPath, {
    maxEntries: DEFAULTS.groupMemoryMaxEntries
  });
  const selectiveMemory = new SelectiveMemoryStore(DEFAULTS.selectiveMemoryPath, {
    capacity: DEFAULTS.selectiveMemoryCapacity,
    expirationMs: DEFAULTS.selectiveMemoryExpirationMs,
    reinforcementThreshold: DEFAULTS.selectiveMemoryReinforcementThreshold
  });
  const contextBuilder = new ContextBuilder(longTerm, { selectiveMemory, groupMemory });
  const episodicMemory = new EpisodicMemoryStore(DEFAULTS.episodicMemoryPath);
  const channelRegistry = new ChannelRegistry(DEFAULTS.channelRegistryPath, {
    largeGroupSize: DEFAULTS.groupPassiveSize
  });
  const groupEngagement = new GroupEngagementWindow({
    ttlMs: DEFAULTS.groupEngagementMs,
    muteMs: DEFAULTS.groupMuteMs
  });
  const tetoActivation = new TetoActivationStore(DEFAULTS.tetoActivationPath, {
    activationRequired: DEFAULTS.tetoActivationRequired
  });
  const stickerRepertoireMode = new StickerRepertoireModeStore(DEFAULTS.stickerRepertoireModePath);
  const viewOnceMirrorStore = new ViewOnceMirrorStore(DEFAULTS.viewOnceMirrorPath);
  const visualKnowledge = new VisualKnowledgeStore(DEFAULTS.visualKnowledgePath);
  const brain = createLlmClient({
    model: DEFAULTS.llmProvider === "minimax" ? DEFAULTS.minimaxModel : DEFAULTS.model,
    temperature: DEFAULTS.ollamaTemperature,
    numPredict: DEFAULTS.ollamaNumPredict
  });
  const searchAdapter = new SearchAdapter({
    maxResults: DEFAULTS.searchMaxResults,
    backend: DEFAULTS.openaiApiKey ? DEFAULTS.searchBackend : "duckduckgo",
    openai: DEFAULTS.openaiApiKey
      ? createOpenAIClient({ temperature: 0.2, kind: "worker", purpose: "busca", timeoutMs: 60_000 })
      : null
  });
  const searchModule = new SearchModule({
    adapter: searchAdapter,
    enabled: DEFAULTS.searchEnabled
  });
  const documentStore = new DocumentStore(DEFAULTS.documentsPath);
  const documentWriter = new DocumentWriter({ store: documentStore, brain });
  const documentModule = new DocumentModule({ store: documentStore, writer: documentWriter });
  const logger = new Logger(DEFAULTS.logPath);
  const metrics = new MetricsStore(DEFAULTS.metricsPath);
  const pendingConfirmations = new PendingConfirmationStore(DEFAULTS.pendingConfirmationsPath);
  const reminders = new ReminderStore(DEFAULTS.remindersPath);
  const multimodalMemory = new MultimodalMemoryStore(DEFAULTS.multimodalMemoryPath, {
    maxPerScope: DEFAULTS.multimodalMaxPerScope
  });
  const audioTranscriptions = new AudioTranscriptionStore(DEFAULTS.audioTranscriptionsPath);
  const audioTranscriber = new AudioTranscriber({
    enabled: DEFAULTS.audioTranscribeEnabled,
    // Sem Groq configurado e com chave da OpenAI: transcreve pela OpenAI (o Whisper local fica de reserva).
    ...(!process.env.TETOS_STT_API_KEY && DEFAULTS.openaiApiKey
      ? {
          api: {
            url: `${DEFAULTS.openaiBaseUrl}/audio/transcriptions`,
            key: DEFAULTS.openaiApiKey,
            model: DEFAULTS.openaiSttModel,
            onUsage: (seconds) => sharedOpenAIUsage().add((seconds / 60) * 0.003, "áudio")
          }
        }
      : {}),
    model: DEFAULTS.whisperModel,
    language: DEFAULTS.whisperLanguage,
    modelsDir: DEFAULTS.modelsDir
  });
  const visualAnalyses = new VisualAnalysisStore(DEFAULTS.visualAnalysesPath, {
    maxPerScope: DEFAULTS.visualAnalysesMaxPerScope
  });
  const visualAnalyzer = new VisualAnalyzer();
  const semanticVisionAnalyzer = new SemanticVisionAnalyzer();
  const visionModel = DEFAULTS.visionModel || DEFAULTS.model;
  const useOpenAIVision = DEFAULTS.visionProvider === "openai" && Boolean(DEFAULTS.openaiApiKey);
  const ollamaVisionAnalyzer = new OllamaVisionAnalyzer({
    client: useOpenAIVision
      ? createOpenAIClient({
          model: DEFAULTS.visionModel,
          temperature: DEFAULTS.ollamaTemperature,
          numPredict: 160,
          kind: "worker",
          timeoutMs: DEFAULTS.visionTimeoutMs,
          purpose: "visão"
        })
      : new OllamaClient({
      baseUrl: DEFAULTS.ollamaBaseUrl,
      model: visionModel,
      apiKey: DEFAULTS.ollamaApiKey || undefined,
      keyPool: sharedOllamaKeyPool(),
      temperature: DEFAULTS.ollamaTemperature,
      numPredict: 120,
      timeoutMs: DEFAULTS.visionTimeoutMs
    }),
    enabled:
      DEFAULTS.visionAdapter === "ollama" &&
      DEFAULTS.visionEnabled &&
      DEFAULTS.mediaEnrichEnabled
  });
  const linkReader = new LinkReader({
    describeImageFile: (filePath) => ollamaVisionAnalyzer?.analyze?.({ filePath, mediaType: "image" }) ?? null
  });
  const primaryVisionAnalyzer =
    DEFAULTS.visionAdapter === "ollama" ? ollamaVisionAnalyzer : semanticVisionAnalyzer;

  const MULTIMODAL_MODEL_RE =
    /llava|vision|gemma.*4|minicpm-v|moondream|bakllava|llama3\.2-vision|pixtral|qwen.*vl/i;
  if (
    DEFAULTS.visionAdapter === "ollama" &&
    DEFAULTS.visionEnabled &&
    DEFAULTS.mediaEnrichEnabled &&
    !useOpenAIVision &&
    !DEFAULTS.visionModel &&
    !MULTIMODAL_MODEL_RE.test(String(DEFAULTS.model ?? ""))
  ) {
    console.warn(
      "[tetos:vision] TETOS_VISION_MODEL vazio e TETOS_MODEL não parece multimodal — " +
        "defina TETOS_VISION_MODEL=llava (local) ou gemma4:31b:cloud (cloud) para leitura de imagens."
    );
  }

  const imageGenerationService = new ImageGenerationService({
    enabled: DEFAULTS.imageGenEnabled,
    provider: DEFAULTS.imageGenProvider,
    hfToken: DEFAULTS.hfToken,
    openai: DEFAULTS.openaiApiKey
      ? {
          apiKey: DEFAULTS.openaiApiKey,
          baseUrl: DEFAULTS.openaiBaseUrl,
          ecoModel: DEFAULTS.openaiImageModel,
          ecoQuality: DEFAULTS.openaiImageQuality,
          hdModel: DEFAULTS.openaiImageHdModel,
          hdQuality: DEFAULTS.openaiImageHdQuality,
          usage: sharedOpenAIUsage()
        }
      : null,
    outputDir: DEFAULTS.imageGenOutputDir,
    maxPer10Min: DEFAULTS.imageGenMaxPer10Min,
    statsPath: DEFAULTS.imageGenStatsPath,
    hdOwnerOnly: DEFAULTS.openaiImageHdOwnerOnly
  });
  const reminderScheduler = new ReminderScheduler({
    reminders,
    logger,
    metrics,
    maxDeliveryAttempts: DEFAULTS.reminderMaxDeliveryAttempts,
    retryDelayMs: DEFAULTS.reminderDeliveryRetryMs
  });
  const personality = loadPersonality(DEFAULTS.personalityPath);
  const character = loadCharacter(DEFAULTS.characterPath);
  const ownerIds = [...ownerIdentityIds({ defaults: DEFAULTS })];
  const anonymizer = new PrivacyAnonymizer({
    mode: DEFAULTS.thirdPartyAnonymization,
    targetUserId: DEFAULTS.learningTargetUserId,
    ownerIds
  });
  const eventLedger = new EventLedger({
    basePath: DEFAULTS.learningLedgerPath,
    timeZone: DEFAULTS.dailyReportTz,
    anonymizer
  });
  const behaviorProfiler = new BehaviorProfiler(DEFAULTS.behaviorProfilesPath, {
    targetUserId: DEFAULTS.learningTargetUserId,
    ownerIds
  });
  const learningFocus = new FocusConfigStore(DEFAULTS.learningFocusPath);
  const dailyReportGenerator = new DailyReportGenerator({
    reportsPath: DEFAULTS.dailyReportsPath,
    ledger: eventLedger,
    behaviorProfiler,
    focusStore: learningFocus,
    timeZone: DEFAULTS.dailyReportTz,
    mindLogPath: DEFAULTS.mindLogPath
  });
  const internalState = new InternalState(DEFAULTS.statePath);
  const timeStore = new TimeStore(DEFAULTS.timePath);
  const userPatterns = new UserPatternsStore(DEFAULTS.userPatternsPath);

  const workerLlm =
    DEFAULTS.llmProvider === "minimax" || DEFAULTS.llmProvider === "openai" || DEFAULTS.workerLlmUrl
      ? createLlmClient({
          model:
            DEFAULTS.llmProvider === "minimax"
              ? DEFAULTS.minimaxWorkerModel
              : DEFAULTS.workerLlmModel || DEFAULTS.model,
          temperature: 0.4,
          numPredict: 120,
          worker: true
        })
      : null;

  // Caderno de memória por pessoa/grupo: consolidado pelo modelo auxiliar (resposta maior que a do worker).
  const peopleMemory = new PeopleMemory(DEFAULTS.peopleMemoryPath, {
    llm: createLlmClient({
      model: DEFAULTS.llmProvider === "minimax" ? DEFAULTS.minimaxWorkerModel : DEFAULTS.workerLlmModel || DEFAULTS.model,
      temperature: 0.2,
      numPredict: 900,
      worker: true
    }),
    timeZone: DEFAULTS.dailyReportTz ?? "America/Sao_Paulo"
  });

  const relationshipStore = new RelationshipCommitmentStore(DEFAULTS.relationshipStatePath, {
    bus: null
  });

  const brainOrchestrator = DEFAULTS.brainEnabled
    ? new BrainOrchestrator({
        enabled: true,
        shortTerm,
        longTerm,
        selectiveMemory,
        groupMemory,
        episodicMemory,
        multimodalMemory,
        visualAnalyses,
        contextBuilder,
        behaviorProfiler,
        timeStore,
        userPatterns,
        relationshipStore,
        lifeProfilePath: DEFAULTS.lifeProfilePath,
        lifeStatePath: DEFAULTS.lifeStatePath,
        lifeJournalPath: DEFAULTS.lifeJournalPath,
        autonomousStatePath: DEFAULTS.autonomousStatePath,
        emotionStatePath: DEFAULTS.emotionStatePath,
        bodyNeedsPath: DEFAULTS.bodyNeedsPath,
        healthStatePath: DEFAULTS.healthStatePath,
        socialGraphPath: DEFAULTS.socialGraphPath,
        trustBondsPath: DEFAULTS.trustBondsPath,
        worldContextPath: DEFAULTS.worldContextPath,
        discographyPath: DEFAULTS.musicDiscographyPath,
        musicStatePath: DEFAULTS.musicStatePath,
        absorbedPatternsPath: DEFAULTS.absorbedPatternsPath,
        mediaLearningPath: DEFAULTS.mediaLearningPath,
        mindLogPath: DEFAULTS.mindLogPath,
        mindLogEnabled: DEFAULTS.mindLogEnabled,
        mindLogMode: DEFAULTS.mindLogMode,
        groupMemoryPath: DEFAULTS.groupMemoryPath,
        dailyLifeStatePath: DEFAULTS.dailyLifeStatePath,
        timeZone: DEFAULTS.dailyReportTz ?? "America/Sao_Paulo",
        episodicMemoryPath: DEFAULTS.episodicMemoryPath,
        timingEnabled: DEFAULTS.timingEngineEnabled,
        backgroundTickMs: DEFAULTS.brainBackgroundTickMs,
        musicResearchIntervalMs: DEFAULTS.musicResearchIntervalMs,
        soloThoughtIntervalMs: DEFAULTS.soloThoughtIntervalMs,
        searchAdapter: searchAdapter.freeOnly(),
        workerLlm,
        visionAdapter: primaryVisionAnalyzer,
        adapters: {
          web: searchAdapter.freeOnly(),
          worker: workerLlm,
          vision: primaryVisionAnalyzer
        }
      })
    : null;

  if (brainOrchestrator && eventLedger) {
    const originalAppend = eventLedger.append.bind(eventLedger);
    eventLedger.append = (event) => {
      const result = originalAppend(event);
      brainOrchestrator.onLedgerEvent(event);
      return result;
    };
  }

  const agent = new Agent({
    personality,
    character,
    internalState,
    shortTerm,
    longTerm,
    brain,
    contextBuilder,
    brainOrchestrator
  });
  const responseProcessor = new ResponseProcessorPool({
    maxParts: DEFAULTS.responseMaxParts,
    similarityThreshold: DEFAULTS.responseSimilarity,
    historyLimit: DEFAULTS.responseHistoryLimit
  });
  const chatService = new ChatService(agent, responseProcessor, internalState, { shortTerm });
  const channelAdmin = new ChannelAdminService(channelRegistry);
  const operationRouter = new OperationRouter({
    channelAdmin,
    documentModule,
    adminUserId: DEFAULTS.adminUserId,
    pendingConfirmations
  });
  const viewOnceMirror = new ViewOnceMirrorService({
    store: viewOnceMirrorStore,
    runtime: null
  });
  const chatCommandRouter = new ChatCommandRouter({
    operationRouter,
    documentModule
  });

  const runtime = {
    shortTerm,
    longTerm,
    contextBuilder,
    selectiveMemory,
    groupMemory,
    episodicMemory,
    channelRegistry,
    groupEngagement,
    channelAdmin,
    tetoActivation,
    stickerRepertoireMode,
    viewOnceMirrorStore,
    viewOnceMirror,
    visualKnowledge,
    whatsappSockets: {},
    searchModule,
    documentModule,
    operationRouter,
    chatCommandRouter,
    logger,
    metrics,
    pendingConfirmations,
    reminders,
    multimodalMemory,
    audioTranscriptions,
    audioTranscriber,
    linkReader,
    weather: new WeatherService(),
    automateBridge: new AutomateApiClient(),
    peopleMemory,
    voiceNotes: new VoiceNotes(
      DEFAULTS.ttsProvider === "openai" && DEFAULTS.openaiApiKey
        ? {
            provider: "openai",
            openai: {
              apiKey: DEFAULTS.openaiApiKey,
              baseUrl: DEFAULTS.openaiBaseUrl,
              model: DEFAULTS.openaiTtsModel,
              voice: DEFAULTS.openaiTtsVoice,
              instructions: DEFAULTS.openaiTtsInstructions,
              usage: sharedOpenAIUsage()
            }
          }
        : {}
    ),
    openaiUsage: DEFAULTS.llmProvider === "openai" || DEFAULTS.openaiApiKey ? sharedOpenAIUsage() : null,
    initiativeState: new InitiativeState(DEFAULTS.initiativeStatePath),
    imageGenerationService,
    convenus: DEFAULTS.convenusUrls.length ? new ConvenusClient({ baseUrls: DEFAULTS.convenusUrls, outputDir: DEFAULTS.commandMediaDerivedPath }) : null,
    visualAnalyses,
    visualAnalyzer,
    semanticVisionAnalyzer,
    ollamaVisionAnalyzer,
    primaryVisionAnalyzer,
    anonymizer,
    eventLedger,
    behaviorProfiler,
    learningFocus,
    dailyReportGenerator,
    reminderScheduler,
    brain,
    workerLlm,
    brainOrchestrator,
    relationshipStore,
    agent,
    responseProcessor,
    chatService,
    internalState,
    timeStore,
    userPatterns,
    deferredInbox: new DeferredInbox(DEFAULTS.deferredInboxPath),
    identityLinks: new IdentityLinkStore(DEFAULTS.identityLinksPath),
    attention: new AttentionFocus(),
    summons: new SummonWindow(),
    // Os ciclos só começam com `priceWatch.start()` (o runner chama).
    priceWatch: new PriceWatch({
      path: DEFAULTS.priceWatchPath,
      sources: new PriceSources(),
      timeZone: DEFAULTS.dailyReportTz,
      intervalMs: Math.max(30, DEFAULTS.priceWatchIntervalMin || 180) * 60_000,
      digestHour: DEFAULTS.priceWatchDigestHour,
      changeAlertPct: DEFAULTS.priceWatchChangePct,
      commandPrefix: DEFAULTS.commandPrefix
    }),
    defaults: DEFAULTS
  };
  viewOnceMirror.runtime = runtime;
  // Mente/autoevolução só usam busca grátis: era ela que gastava a maior parte da API.
  runtime.mind = DEFAULTS.mindEnabled ? createMind(runtime, { searchAdapter: searchAdapter.freeOnly(), linkReader }) : null;
  return runtime;
}

/**
 * Mente + autoevolução. Os ciclos só começam com `runtime.mind.start()` (o runner chama; testes e a
 * API não), então criar aqui não gasta nada.
 */
function createMind(runtime, { searchAdapter, linkReader }) {
  const mindModel = DEFAULTS.mindModel || (DEFAULTS.llmProvider === "minimax" ? DEFAULTS.minimaxWorkerModel : DEFAULTS.workerLlmModel || DEFAULTS.model);
  const mindLlm = createLlmClient({ model: mindModel, temperature: 0.3, numPredict: 1800, worker: true, timeoutMs: 120_000, purpose: "mente" });
  const search = (q) => searchAdapter.search(q);
  // Avisos pra dona no zap, filtrados pelo nível que ela escolheu (.mente avisos tudo|importante|nada).
  const notifyOwner = async (text, { kind = "info" } = {}) => {
    if (runtime.mind && !runtime.mind.shouldNotify(kind)) return;
    enqueueOutbox(DEFAULTS.whatsappOutboxPath, { to: "dona", text, by: "mente" });
  };
  let evolution = null;
  if (DEFAULTS.evolutionEnabled) {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const evolutionDir = resolvePath(DEFAULTS.evolutionPath);
    const store = new OverlayStore(root, { dir: evolutionDir });
    const skills = new SkillManager({
      dir: resolvePath(evolutionDir, "skills"),
      corpus: () => runtime.mind?.turns?.turns?.map((t) => t.input) ?? [],
      tools: {
        pesquisar: async (q) => (await search(q)).map((r) => ({ titulo: r.title, trecho: r.snippet ?? "", url: r.url })),
        ler: async (url) => {
          if (!/^https?:\/\//i.test(String(url))) throw new Error("url inválida");
          const page = await linkReader?.read?.(String(url));
          return String(page?.body ?? page?.text ?? page?.title ?? "").slice(0, 3000);
        },
        // Qualquer API/página pública (GET/POST com JSON), sem segredo nosso; bloqueia endereço interno.
        web: (url, opcoes) => publicFetch(url, opcoes)
      }
    });
    const codeLlm = createLlmClient({
      model: DEFAULTS.evolutionModel || mindModel,
      temperature: 0.15,
      numPredict: 6000,
      worker: true,
      kind: "code",
      purpose: "autoevolução",
      timeoutMs: 240_000
    });
    evolution = new EvolutionEngine({
      root,
      dir: evolutionDir,
      store,
      verifier: new ChangeVerifier({ root, store, evolutionDir }),
      skills,
      llm: codeLlm,
      notifyOwner,
      isAsleep: () => runtime.brainOrchestrator?.life?.availability?.()?.mode === "asleep",
      lastActivityAt: () => runtime.mind?.lastActivityAt ?? 0,
      codeEnabled: DEFAULTS.evolutionCodeEnabled,
      maxCodePerDay: DEFAULTS.evolutionMaxCodePerDay
    });
  }
  const mind = new Mind({
    dir: DEFAULTS.mindPath,
    llm: mindLlm,
    search,
    reader: linkReader,
    evolution,
    life: runtime.brainOrchestrator?.life ?? null,
    notifyOwner,
    limits: { studyPerDay: DEFAULTS.mindStudyPerDay, lookupsPerDay: DEFAULTS.mindLookupsPerDay }
  });
  if (evolution) {
    evolution.journal = mind.journal;
    evolution.feel = (feeling, delta, cause) => mind.feelings.feel(feeling, delta, { cause });
  }
  if (runtime.brainOrchestrator) runtime.brainOrchestrator.feelings = mind.feelings;
  return mind;
}

export async function handleIncomingMessage(runtime, payload = {}) {
  return runMessagePipeline(runtime, payload);
}
