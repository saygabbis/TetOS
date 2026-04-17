import { DEFAULTS } from "../infra/config/defaults.js";
import { ShortTermMemory } from "../core/memory/shortTerm.js";
import { LongTermMemory } from "../core/memory/longTerm.js";
import { ContextBuilder } from "../core/memory/contextBuilder.js";
import { SelectiveMemoryStore } from "../core/memory/selectiveMemory.js";
import { OllamaClient } from "../core/brain/ollamaClient.js";
import { Agent } from "../core/agent/agent.js";
import { ChatService } from "../modules/chat/chatService.js";
import { ResponseProcessor } from "../modules/chat/responseProcessor.js";
import { BasicLoop } from "../modules/scheduler/basicLoop.js";
import { InternalState } from "../core/state/internalState.js";
import { TimeStore } from "../core/time/timeStore.js";
import { UserPatternsStore } from "../core/time/userPatternsStore.js";
import { ChannelRegistry } from "../core/channels/channelRegistry.js";
import { ChannelAdminService } from "../core/channels/channelAdmin.js";
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

export function createRuntime() {
  if (DEFAULTS.ollamaMode === "cloud" && !DEFAULTS.ollamaApiKey) {
    throw new Error(
      "TETOS_OLLAMA_MODE=cloud requer TETOS_OLLAMA_API_KEY (ou OLLAMA_API_KEY). Crie uma chave em https://ollama.com/settings/keys"
    );
  }

  const shortTerm = new ShortTermMemory(DEFAULTS.maxShortTerm);
  const longTerm = new LongTermMemory(DEFAULTS.memoryPath);
  const contextBuilder = new ContextBuilder(longTerm);
  const selectiveMemory = new SelectiveMemoryStore(DEFAULTS.selectiveMemoryPath, {
    capacity: DEFAULTS.selectiveMemoryCapacity,
    expirationMs: DEFAULTS.selectiveMemoryExpirationMs,
    reinforcementThreshold: DEFAULTS.selectiveMemoryReinforcementThreshold
  });
  const channelRegistry = new ChannelRegistry(DEFAULTS.channelRegistryPath, {
    largeGroupSize: DEFAULTS.groupPassiveSize
  });
  const brain = new OllamaClient({
    baseUrl: DEFAULTS.ollamaBaseUrl,
    model: DEFAULTS.model,
    apiKey: DEFAULTS.ollamaApiKey || undefined,
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
  const multimodalMemory = new MultimodalMemoryStore(DEFAULTS.multimodalMemoryPath);
  const audioTranscriptions = new AudioTranscriptionStore(DEFAULTS.audioTranscriptionsPath);
  const audioTranscriber = new AudioTranscriber();
  const visualAnalyses = new VisualAnalysisStore(DEFAULTS.visualAnalysesPath);
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
  const internalState = new InternalState(DEFAULTS.statePath);
  const timeStore = new TimeStore(DEFAULTS.timePath);
  const userPatterns = new UserPatternsStore(DEFAULTS.userPatternsPath);
  const agent = new Agent({
    personality,
    character,
    internalState,
    shortTerm,
    longTerm,
    brain,
    contextBuilder
  });
  const responseProcessor = new ResponseProcessor({
    maxParts: DEFAULTS.responseMaxParts,
    similarityThreshold: DEFAULTS.responseSimilarity,
    historyLimit: DEFAULTS.responseHistoryLimit
  });
  const basicLoop = new BasicLoop({
    inactiveMs: DEFAULTS.presenceInactiveMs,
    minCooldownMs: DEFAULTS.presenceMinCooldownMs,
    maxCooldownMs: DEFAULTS.presenceMaxCooldownMs,
    maxDailyPerUser: DEFAULTS.presenceMaxDailyPerUser
  });
  const chatService = new ChatService(agent, responseProcessor, internalState);
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
    channelRegistry,
    channelAdmin,
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
    reminderScheduler,
    brain,
    agent,
    responseProcessor,
    basicLoop,
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
