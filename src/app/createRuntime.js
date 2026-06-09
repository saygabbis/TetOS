import { DEFAULTS } from "../infra/config/defaults.js";
import { ownerIdentityIds } from "../core/channels/userActivity.js";
import { ShortTermMemory } from "../core/memory/shortTerm.js";
import { LongTermMemory } from "../core/memory/longTerm.js";
import { ContextBuilder } from "../core/memory/contextBuilder.js";
import { SelectiveMemoryStore } from "../core/memory/selectiveMemory.js";
import { GroupMemoryStore } from "../core/memory/GroupMemoryStore.js";
import { EpisodicMemoryStore } from "../core/memory/EpisodicMemoryStore.js";
import { OllamaClient } from "../core/brain/ollamaClient.js";
import { MiniMaxClient } from "../core/brain/minimaxClient.js";
import { BrainOrchestrator } from "../core/brain/BrainOrchestrator.js";
import { Agent } from "../core/agent/agent.js";
import { ChatService } from "../modules/chat/chatService.js";
import { ResponseProcessorPool } from "../modules/chat/responseProcessorPool.js";
import { BasicLoop } from "../modules/scheduler/basicLoop.js";
import { InitiationQueue } from "../core/autonomy/initiationQueue.js";
import { InitiationEngine } from "../core/autonomy/initiationEngine.js";
import { InternalState } from "../core/state/internalState.js";
import { TimeStore } from "../core/time/timeStore.js";
import { UserPatternsStore } from "../core/time/userPatternsStore.js";
import { ChannelRegistry } from "../core/channels/channelRegistry.js";
import { GroupEngagementWindow } from "../core/channels/groupEngagementWindow.js";
import { ChannelAdminService } from "../core/channels/channelAdmin.js";
import { TetoActivationStore } from "../core/channels/TetoActivationStore.js";
import { runMessagePipeline } from "../core/pipeline/messagePipeline.js";
import { SearchAdapter } from "../modules/search/searchAdapter.js";
import { SearchModule } from "../modules/search/searchModule.js";
import { DocumentStore } from "../modules/documents/documentStore.js";
import { DocumentWriter } from "../modules/documents/documentWriter.js";
import { DocumentModule } from "../modules/documents/documentModule.js";
import { OperationRouter } from "../core/operations/operationRouter.js";
import { ChatCommandRouter } from "../core/operations/chatCommandRouter.js";
import { PendingConfirmationStore } from "../core/operations/pendingConfirmations.js";
import { ReminderStore } from "../modules/reminders/reminderStore.js";
import { ReminderScheduler } from "../modules/reminders/reminderScheduler.js";
import { MultimodalMemoryStore } from "../core/memory/multimodalMemory.js";
import { AudioTranscriptionStore } from "../modules/audio/audioTranscriptionStore.js";
import { AudioTranscriber } from "../modules/audio/audioTranscriber.js";
import { VisualAnalysisStore } from "../modules/vision/visualAnalysisStore.js";
import { VisualAnalyzer } from "../modules/vision/visualAnalyzer.js";
import { SemanticVisionAnalyzer } from "../modules/vision/semanticVisionAnalyzer.js";
import { Logger } from "../infra/observability/logger.js";
import { MetricsStore } from "../infra/observability/metricsStore.js";
import { loadCharacter, loadPersonality } from "../core/personality/index.js";
import { PrivacyAnonymizer } from "../core/privacy/anonymizer.js";
import { EventLedger } from "../core/learning/eventLedger.js";
import { BehaviorProfiler } from "../core/learning/behaviorProfiler.js";
import { FocusConfigStore } from "../core/learning/focusConfigStore.js";
import { DailyReportGenerator } from "../core/learning/dailyReportGenerator.js";

function createLlmClient({ model, temperature, numPredict, worker = false } = {}) {
  if (DEFAULTS.llmProvider === "minimax") {
    return new MiniMaxClient({
      baseUrl: DEFAULTS.minimaxBaseUrl,
      model: model ?? (worker ? DEFAULTS.minimaxWorkerModel : DEFAULTS.minimaxModel),
      apiKey: DEFAULTS.minimaxApiKey || undefined,
      temperature,
      numPredict,
      timeoutMs: DEFAULTS.modelTimeoutMs,
      thinking: worker ? { type: "disabled" } : { type: "disabled" }
    });
  }
  return new OllamaClient({
    baseUrl: DEFAULTS.ollamaBaseUrl,
    model: model ?? DEFAULTS.model,
    apiKey: DEFAULTS.ollamaApiKey || undefined,
    temperature,
    numPredict
  });
}

export function createRuntime() {
  if (DEFAULTS.llmProvider === "minimax") {
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
    ttlMs: DEFAULTS.groupEngagementMs
  });
  const tetoActivation = new TetoActivationStore(DEFAULTS.tetoActivationPath, {
    activationRequired: DEFAULTS.tetoActivationRequired
  });
  const brain = createLlmClient({
    model: DEFAULTS.llmProvider === "minimax" ? DEFAULTS.minimaxModel : DEFAULTS.model,
    temperature: DEFAULTS.ollamaTemperature,
    numPredict: DEFAULTS.ollamaNumPredict
  });
  const searchAdapter = new SearchAdapter({
    maxResults: DEFAULTS.searchMaxResults
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
  const audioTranscriber = new AudioTranscriber();
  const visualAnalyses = new VisualAnalysisStore(DEFAULTS.visualAnalysesPath, {
    maxPerScope: DEFAULTS.visualAnalysesMaxPerScope
  });
  const visualAnalyzer = new VisualAnalyzer();
  const semanticVisionAnalyzer = new SemanticVisionAnalyzer();
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
    DEFAULTS.llmProvider === "minimax" || DEFAULTS.workerLlmUrl
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
        groupMemoryPath: DEFAULTS.groupMemoryPath,
        episodicMemoryPath: DEFAULTS.episodicMemoryPath,
        timingEnabled: DEFAULTS.timingEngineEnabled,
        backgroundTickMs: DEFAULTS.brainBackgroundTickMs,
        musicResearchIntervalMs: DEFAULTS.musicResearchIntervalMs,
        soloThoughtIntervalMs: DEFAULTS.soloThoughtIntervalMs,
        searchAdapter,
        workerLlm,
        visionAdapter: semanticVisionAnalyzer,
        adapters: {
          web: searchAdapter,
          worker: workerLlm,
          vision: semanticVisionAnalyzer
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
  const initiationQueue = new InitiationQueue(DEFAULTS.initiationQueuePath);
  const initiationEngine = new InitiationEngine({
    brainOrchestrator,
    timeStore,
    userPatterns,
    internalState,
    shortTerm,
    longTerm,
    initiationQueue
  });
  const basicLoop = new BasicLoop({
    inactiveMs: DEFAULTS.presenceInactiveMs,
    chance: DEFAULTS.initiationChance,
    minCooldownMs: DEFAULTS.presenceMinCooldownMs,
    maxCooldownMs: DEFAULTS.presenceMaxCooldownMs,
    maxDailyPerUser: DEFAULTS.presenceMaxDailyPerUser,
    brainOrchestrator,
    timeStore,
    userPatterns
  });
  const chatService = new ChatService(agent, responseProcessor, internalState, { shortTerm });
  const channelAdmin = new ChannelAdminService(channelRegistry);
  const operationRouter = new OperationRouter({
    channelAdmin,
    documentModule,
    adminUserId: DEFAULTS.adminUserId,
    pendingConfirmations
  });
  const chatCommandRouter = new ChatCommandRouter({
    operationRouter,
    documentModule
  });

  return {
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
    visualAnalyses,
    visualAnalyzer,
    semanticVisionAnalyzer,
    anonymizer,
    eventLedger,
    behaviorProfiler,
    learningFocus,
    dailyReportGenerator,
    reminderScheduler,
    brain,
    brainOrchestrator,
    agent,
    responseProcessor,
    basicLoop,
    initiationQueue,
    initiationEngine,
    chatService,
    internalState,
    timeStore,
    userPatterns,
    defaults: DEFAULTS
  };
}

export async function handleIncomingMessage(runtime, payload = {}) {
  return runMessagePipeline(runtime, payload);
}
