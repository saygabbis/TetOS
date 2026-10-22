import { SignalBus } from "./SignalBus.js";
import { RepetitionAwareness } from "./RepetitionAwareness.js";
import { EmotionSystem } from "../emotion/EmotionSystem.js";
import { DailyLife } from "../life/dailyLife.js";
import { LifeNarrator } from "../life/LifeNarrator.js";
import { TrustIntimacySystem } from "../social/TrustIntimacySystem.js";
import { RelationshipCommitmentStore } from "../social/RelationshipCommitmentStore.js";
import { MusicWorld } from "../music/MusicWorld.js";
import { TimingEngine } from "../timing/TimingEngine.js";
import { MemoryOrchestrator } from "../memory/MemoryOrchestrator.js";
import { MediaLearningHub } from "../media/MediaLearningHub.js";
import { AbsorbedKnowledgeBridge } from "../learning/absorbedKnowledgeBridge.js";
import { CreativeInsightEngine } from "../learning/CreativeInsightEngine.js";
import { MindLogger } from "../consciousness/MindLogger.js";
import { AdapterRegistry } from "../adapters/AdapterRegistry.js";
import { CandidateArbitrator } from "./CandidateArbitrator.js";
import { analyzeConversationPhase } from "./ConversationPhaseEngine.js";

export class BrainOrchestrator {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.bus = new SignalBus();
    this.repetition = new RepetitionAwareness(config.repetitionPath ?? "./data/repetitionState.json");
    this.behaviorProfiler = config.behaviorProfiler ?? null;
    this.timeStore = config.timeStore ?? null;
    this.userPatterns = config.userPatterns ?? null;

    this.emotion = new EmotionSystem(config.emotionStatePath, {
      bodyPath: null,
      healthPath: config.healthStatePath,
      bus: this.bus
    });
    this.trust = new TrustIntimacySystem(config.trustBondsPath, { bus: this.bus });
    this.relationship =
      config.relationshipStore ??
      new RelationshipCommitmentStore(config.relationshipStatePath ?? "./data/relationshipState.json", {
        bus: this.bus
      });
    this.music = new MusicWorld(config.discographyPath, config.musicStatePath, {
      bus: this.bus,
      searchAdapter: config.searchAdapter
    });
    // A vida dela (rotina, sono, disponibilidade, humor) vem do plano do dia — uma fonte só,
    // igual em qualquer processo. Substitui o motor antigo de atividades/obrigações/NPCs.
    this.life = config.dailyLife ?? new DailyLife({
      statePath: config.dailyLifeStatePath ?? "./data/life/state.json",
      timeZone: config.timeZone ?? "America/Sao_Paulo",
      bus: this.bus
    });
    this.absorbed = new AbsorbedKnowledgeBridge(config.absorbedPatternsPath, { bus: this.bus });
    this.insights = new CreativeInsightEngine({
      bridge: this.absorbed,
      bus: this.bus
    });

    this.timing = new TimingEngine({
      enabled: config.timingEnabled !== false,
      getAbsorbedPatterns: () => this.absorbed.getPatterns(),
      behaviorProfiler: this.behaviorProfiler
    });
    this.mediaHub = new MediaLearningHub(config.mediaLearningPath, {
      bus: this.bus,
      visionAdapter: config.visionAdapter ?? null
    });
    this.memory = new MemoryOrchestrator({
      shortTerm: config.shortTerm,
      longTerm: config.longTerm,
      selectiveMemory: config.selectiveMemory,
      groupMemory: config.groupMemory,
      episodicMemory: config.episodicMemory,
      multimodalMemory: config.multimodalMemory,
      visualAnalyses: config.visualAnalyses,
      contextBuilder: config.contextBuilder,
      bus: this.bus
    });
    this.narrator = new LifeNarrator();
    this.mindLogger = config.mindLogEnabled
      ? new MindLogger(config.mindLogPath, { enabled: true, mode: config.mindLogMode ?? "slim" })
      : null;
    this.adapters = new AdapterRegistry(config.adapters ?? {});
    this.arbitrator = new CandidateArbitrator();

    this._backgroundTimer = null;
    this.backgroundTickMs = config.backgroundTickMs;
    if (config.backgroundTickMs > 0) {
      this._backgroundTimer = setInterval(() => this.tickBackground(), config.backgroundTickMs);
      if (this._backgroundTimer.unref) this._backgroundTimer.unref();
    }

    this.reconcileSleepFromSchedule();
  }

  reconcileSleepFromSchedule() {
    this.life.tick();
  }

  /** Humor/energia do dia por cima do sistema de emoções antigo (que travava em "irritada"). */
  emotionSnapshot() {
    const base = this.emotion.getSnapshot();
    const day = this.life.mood();
    return {
      ...base,
      mood: day.mood,
      energy: day.energy,
      social: day.social,
      valence: day.valence,
      body: undefined
    };
  }

  localHour() {
    return Math.floor(this.life.locate().minute / 60) % 24;
  }

  enrichTrustForTiming(userId, channelScope, emotion, hour) {
    const bond = this.trust.getBond(userId, channelScope);
    const influence = this.trust.influenceTiming(userId, channelScope, {
      hourOfDay: hour,
      emotion
    });
    return {
      ...bond,
      ...influence,
      vulnerableReachOut: influence.vulnerableReachOut
    };
  }

  buildTimingContext(turnContext = {}) {
    const hour = turnContext.hourOfDay ?? this.localHour();
    const userId = turnContext.userId ?? "default";
    const channelScope = turnContext.channelScope ?? "direct";
    const emotion = turnContext.emotion ?? this.emotionSnapshot();
    const behaviorSnap = this.behaviorProfiler?.snapshot?.() ?? {};
    const lastMessageAt =
      this.timeStore?.getLastMessage?.(userId, turnContext.sessionId) ?? null;
    const userLikelyActive = this.userPatterns?.isLikelyActiveNow?.(userId) ?? true;
    const trustBond = turnContext.userId
      ? this.enrichTrustForTiming(userId, channelScope, emotion, hour)
      : null;
    const subconscious = this.narrator.buildSubconscious({
      emotion,
      life: this.life.getSnapshot(),
      trustBond,
      repetition: this.repetition.getSnapshot(turnContext.sessionId)
    });

    return {
      ...turnContext,
      hourOfDay: hour,
      emotion,
      body: turnContext.body ?? {},
      health: turnContext.health ?? [],
      life: turnContext.life ?? { ...this.life.getSnapshot(), sleep: this.life.sleep.getSnapshot() },
      sleep: turnContext.sleep ?? this.life.sleep.getSnapshot(),
      trustBond,
      absorbed: turnContext.absorbed ?? this.absorbed.getPatterns(),
      behaviorProfile: behaviorSnap,
      lastMessageAt,
      userLikelyActive,
      hasMedia: Boolean(turnContext.media),
      isDirectQuestion: turnContext.isDirectQuestion ?? /\?/.test(String(turnContext.message ?? "")),
      isMention: turnContext.isDirectMention ?? false,
      isReply: turnContext.isReply ?? false,
      repetition: this.repetition.getSnapshot(turnContext.sessionId),
      subconscious,
      mediaTimingHint: turnContext.media ? this.mediaHub.timingHint() : null,
      closeDecision: turnContext.closeDecision ?? null,
      media: turnContext.media ?? null
    };
  }

  buildSnapshot(turnContext = {}) {
    const lifeSnap = this.life.getSnapshot();
    const emotionSnap = this.emotionSnapshot();
    const sleepSnap = lifeSnap.sleep;
    const trustBond = turnContext.userId
      ? this.enrichTrustForTiming(turnContext.userId, turnContext.channelScope ?? "direct", emotionSnap, this.localHour())
      : null;
    const relationship = turnContext.userId
      ? this.relationship.getSnapshot(turnContext.userId, { longTerm: this.memory?.longTerm })
      : this.relationship.getState();

    return {
      ts: new Date().toISOString(),
      emotion: emotionSnap,
      body: {},
      health: [],
      life: lifeSnap,
      sleep: sleepSnap,
      world: { currentLocation: "sp", isTraveling: false },
      social: {},
      music: {},
      trustBond,
      relationship,
      autonomous: {},
      absorbed: this.absorbed.getPatterns(),
      repetition: this.repetition.getSnapshot(turnContext.sessionId),
      timing: null,
      memory: null,
      media: null
    };
  }

  async tickTurn(turnContext = {}) {
    if (!this.enabled) return { snapshot: {}, blocks: {}, timingPlan: {} };

    this.life.tick();

    if (turnContext.userId && turnContext.message) {
      this.trust.recordInteraction({
        userId: turnContext.userId,
        channelScope: turnContext.channelScope ?? (turnContext.isGroup ? `group:${turnContext.channelId}` : "direct"),
        message: turnContext.message,
        tone: turnContext.tone,
        isVulnerable: turnContext.isVulnerable
      });
    }

    const snapshot = this.buildSnapshot(turnContext);
    snapshot.memory = this.memory.buildRetrievalContext({
      message: turnContext.message,
      userId: turnContext.userId,
      channelId: turnContext.channelId,
      sessionId: turnContext.sessionId,
      isGroup: turnContext.isGroup,
      isOwner: Boolean(turnContext.isOwner)
    });

    if (turnContext.media) {
      snapshot.media = await this.mediaHub.analyze(turnContext.media, turnContext).catch(() =>
        this.mediaHub.learnFromMedia(turnContext.media, turnContext)
      );
    }

    snapshot.conversationPhase = analyzeConversationPhase({
      message: turnContext.message,
      history: turnContext.recentHistory ?? [],
      closeDecisionHint: turnContext.closeDecision,
      trustBond: snapshot.trustBond,
      repetition: snapshot.repetition,
      isDirectQuestion: turnContext.isDirectQuestion,
      isDirectMention: turnContext.isDirectMention,
      isDirectTetoCall: turnContext.isDirectTetoCall,
      isVulnerable: turnContext.isVulnerable,
      resumedAfterClose: turnContext.resumedAfterClose,
      gapSinceLastMs: turnContext.gapSinceLastMs,
      tone: turnContext.tone,
      sessionId: turnContext.sessionId
    });

    const timingCtx = this.buildTimingContext({
      ...turnContext,
      emotion: snapshot.emotion,
      body: snapshot.body,
      health: snapshot.health,
      life: snapshot.life,
      sleep: snapshot.sleep,
      closeDecision:
        snapshot.conversationPhase?.closeDecision ?? turnContext.closeDecision ?? null,
      conversationPhase: snapshot.conversationPhase
    });
    snapshot.timing = this.timing.computePlan(timingCtx);
    this.bus.emit("timing.delay_computed", { plan: snapshot.timing, sessionId: turnContext.sessionId });

    snapshot.arbitration = this.arbitrator.run(snapshot, turnContext);
    if (snapshot.arbitration?.winner?.source === "timing" && snapshot.timing) {
      snapshot.timing.shouldInitiateConversation = true;
      snapshot.timing.initiateReason ??= snapshot.arbitration.winner.detail;
    }

    // Narrador determinístico: a vida vem do plano do dia (o narrador por LLM inventava coisas que
    // não ficavam salvas e custava uma chamada extra por mensagem).
    const blocks = {
      conscious: this.life.promptLines({ isGroup: Boolean(turnContext.isGroup) }).join("\n"),
      subconscious: this.narrator.buildSubconscious(snapshot),
      source: "daily_life_v2"
    };
    return { snapshot, blocks, timingPlan: snapshot.timing };
  }

  async tickBackground() {
    if (!this.enabled) return;
    this.life.tick();
    this.repetition.tick();
    // Vínculo esfria devagar com o tempo real (antes: 1h a cada 2 min).
    this.trust.tick({ hoursElapsed: (this.backgroundTickMs ?? 120000) / 3600000 });
    this.memory.tick();
    this.bus.emit("brain.background_tick", { ts: new Date().toISOString() });
  }

  recordAssistantOutput(sessionId, text, meta = {}) {
    this.repetition.record(sessionId, text, { role: "assistant", ...meta });
  }

  logTurn(entry = {}) {
    this.mindLogger?.append({
      ...entry,
      timingPlan: entry.timingPlan ?? entry.brain?.timing ?? null
    });
  }

  onLedgerEvent(event) {
    this.absorbed.ingestEvent(event);
    this.insights.observe(event);
  }

  destroy() {
    if (this._backgroundTimer) clearInterval(this._backgroundTimer);
  }
}
