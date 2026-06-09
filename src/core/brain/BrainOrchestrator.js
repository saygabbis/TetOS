import { SignalBus } from "./SignalBus.js";
import { RepetitionAwareness } from "./RepetitionAwareness.js";
import { EmotionSystem } from "../emotion/EmotionSystem.js";
import { BodyNeeds } from "../emotion/BodyNeeds.js";
import { HealthConditions } from "../emotion/HealthConditions.js";
import { LifeEngine } from "../life/lifeEngine.js";
import { WorldContext } from "../life/WorldContext.js";
import { AutonomousEvolution } from "../life/AutonomousEvolution.js";
import { LifeNarrator } from "../life/LifeNarrator.js";
import { SocialGraph } from "../social/SocialGraph.js";
import { TrustIntimacySystem } from "../social/TrustIntimacySystem.js";
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
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function ensureJournal(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export class BrainOrchestrator {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.bus = new SignalBus();
    this.repetition = new RepetitionAwareness(config.repetitionPath ?? "./data/repetitionState.json");
    this.behaviorProfiler = config.behaviorProfiler ?? null;
    this.timeStore = config.timeStore ?? null;
    this.userPatterns = config.userPatterns ?? null;
    this.musicResearchIntervalMs = config.musicResearchIntervalMs ?? 86400000;
    this._lastMusicResearchAt = 0;
    this.soloThoughtIntervalMs = config.soloThoughtIntervalMs ?? 300000;
    this._lastSoloThoughtAt = 0;

    const journalPath = config.lifeJournalPath ?? "./data/lifeJournal.ndjson";
    const journalAppend = (entry) => {
      ensureJournal(journalPath);
      appendFileSync(journalPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    };

    this.bodyNeeds = new BodyNeeds(config.bodyNeedsPath ?? "./data/bodyNeeds.json", { bus: this.bus });
    this.health = new HealthConditions(config.healthStatePath, { bus: this.bus });
    this.emotion = new EmotionSystem(config.emotionStatePath, {
      bodyPath: null,
      healthPath: config.healthStatePath,
      bus: this.bus
    });
    this.emotion.body = this.bodyNeeds;
    this.world = new WorldContext(config.worldContextPath, { bus: this.bus, journalAppend });
    this.social = new SocialGraph(config.socialGraphPath, { bus: this.bus, journalAppend });
    this.trust = new TrustIntimacySystem(config.trustBondsPath, { bus: this.bus });
    this.music = new MusicWorld(config.discographyPath, config.musicStatePath, {
      bus: this.bus,
      searchAdapter: config.searchAdapter
    });
    this.life = new LifeEngine({
      profilePath: config.lifeProfilePath,
      statePath: config.lifeStatePath,
      bus: this.bus,
      socialGraph: this.social,
      musicWorld: this.music,
      bodyNeeds: this.bodyNeeds,
      journalAppend,
      workerLlm: config.workerLlm
    });
    this.autonomous = new AutonomousEvolution(config.autonomousStatePath ?? "./data/autonomousState.json", {
      bus: this.bus,
      journalAppend,
      workerLlm: config.workerLlm,
      searchAdapter: config.searchAdapter,
      worldContext: this.world
    });
    this.absorbed = new AbsorbedKnowledgeBridge(config.absorbedPatternsPath, { bus: this.bus });
    this.insights = new CreativeInsightEngine({
      bridge: this.absorbed,
      bus: this.bus
    });
    this.autonomous.insightEngine = this.insights;

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
    this.narrator = new LifeNarrator({ workerLlm: config.workerLlm });
    this.mindLogger = config.mindLogEnabled
      ? new MindLogger(config.mindLogPath, { enabled: true })
      : null;
    this.adapters = new AdapterRegistry(config.adapters ?? {});
    this.arbitrator = new CandidateArbitrator();

    this._backgroundTimer = null;
    if (config.backgroundTickMs > 0) {
      this._backgroundTimer = setInterval(() => this.tickBackground(), config.backgroundTickMs);
      if (this._backgroundTimer.unref) this._backgroundTimer.unref();
    }
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
    const hour = turnContext.hourOfDay ?? new Date().getHours();
    const userId = turnContext.userId ?? "default";
    const channelScope = turnContext.channelScope ?? "direct";
    const emotion = turnContext.emotion ?? this.emotion.getSnapshot();
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
      social: this.social.getSnapshot(),
      trustBond,
      repetition: this.repetition.getSnapshot(turnContext.sessionId)
    });

    return {
      ...turnContext,
      hourOfDay: hour,
      emotion,
      body: turnContext.body ?? this.bodyNeeds.getState(),
      health: turnContext.health ?? this.health.getActive(),
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
      mediaTimingHint: this.mediaHub.timingHint(),
      closeDecision: turnContext.closeDecision ?? null,
      media: turnContext.media ?? null
    };
  }

  buildSnapshot(turnContext = {}) {
    const lifeSnap = this.life.getSnapshot();
    const emotionSnap = this.emotion.getSnapshot();
    const sleepSnap = this.life.sleep.getSnapshot();
    const trustBond = turnContext.userId
      ? this.enrichTrustForTiming(
          turnContext.userId,
          turnContext.channelScope ?? "direct",
          emotionSnap,
          new Date().getHours()
        )
      : null;

    return {
      ts: new Date().toISOString(),
      emotion: emotionSnap,
      body: this.bodyNeeds.getState(),
      health: this.health.getActive(),
      life: { ...lifeSnap, sleep: sleepSnap },
      sleep: sleepSnap,
      world: this.world.getSnapshot(),
      social: this.social.getSnapshot(),
      music: this.music.getSnapshot(),
      trustBond,
      autonomous: this.autonomous.getSnapshot(),
      absorbed: this.absorbed.getPatterns(),
      repetition: this.repetition.getSnapshot(turnContext.sessionId),
      timing: null,
      memory: null,
      media: null
    };
  }

  async tickTurn(turnContext = {}) {
    if (!this.enabled) return { snapshot: {}, blocks: {}, timingPlan: {} };

    const hour = new Date().getHours();
    this.world.tick({
      now: new Date(),
      emotion: this.emotion.getSnapshot(),
      life: this.life.getSnapshot()
    });
    const worldSnap = this.world.getSnapshot();
    this.bodyNeeds.tick({ hourOfDay: hour, activity: this.life.getSnapshot().currentActivity ?? "idle" });
    this.health.tick({
      region: worldSnap.currentLocation,
      climateTags: worldSnap.climateTags,
      sleepQuality: this.life.sleep.getSnapshot().quality ?? 0.7
    });
    this.emotion.tick({
      hourOfDay: hour,
      region: worldSnap.currentLocation,
      climateTags: worldSnap.climateTags,
      sleepQuality: this.life.sleep.getSnapshot().quality ?? 0.7
    });
    this.life.tick({ emotion: this.emotion.getSnapshot(), hour });
    this.social.tick({ emotion: this.emotion.getSnapshot(), availability: this.life.sleep.isAvailable() ? "awake" : "sleeping" });
    this.music.tick({ phase: this.life.getSnapshot().phase, emotion: this.emotion.getSnapshot() });

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
      isGroup: turnContext.isGroup
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

    const useLlmNarrator = Boolean(this.narrator.workerLlm) && (
      turnContext.isVulnerable ||
      turnContext.isDirectMention ||
      turnContext.isReply ||
      (hour >= 22 || hour < 5) ||
      (snapshot.trustBond?.intimacy ?? 0) > 0.65 ||
      snapshot.arbitration?.winner?.weight >= 0.7
    );
    let blocks;
    if (useLlmNarrator) {
      const narrated = await this.narrator.narrate(snapshot, { useLlm: true });
      blocks = {
        conscious: narrated.conscious ?? narrated.consciousBlock?.replace(/^\[CONSCIOUS[^\]]*\]\s*/i, ""),
        subconscious: narrated.subconscious ?? narrated.subconsciousBlock?.replace(/^\[SUBCONSCIOUS[^\]]*\]\s*/i, ""),
        source: narrated.source ?? "worker_llm"
      };
    } else {
      const built = this.narrator.buildBlocks(snapshot);
      blocks = {
        conscious: built.conscious,
        subconscious: built.subconscious,
        source: "deterministic_v1"
      };
    }
    return { snapshot, blocks, timingPlan: snapshot.timing };
  }

  async tickBackground() {
    if (!this.enabled) return;
    const hour = new Date().getHours();
    const emotion = this.emotion.getSnapshot();
    const ctx = { hour, hourOfDay: hour, emotion, availability: this.life.sleep.isAvailable() ? "awake" : "sleeping" };
    this.world.tick({
      now: new Date(),
      emotion,
      life: this.life.getSnapshot()
    });
    this.life.sleep.tick({ hourOfDay: hour, energy: emotion.energy, stress: emotion.stress });
    this.life.tick(ctx);
    this.social.tick(ctx);
    this.music.tick({ life: this.life.getSnapshot(), emotion });
    this.bodyNeeds.tick({ hourOfDay: hour });
    this.health.tick({ world: this.world.getSnapshot() });
    this.emotion.tick({ hourOfDay: hour, body: this.bodyNeeds.getState(), health: this.health.getActive() });
    this.repetition.tick();
    this.trust.tick({ hoursElapsed: 1 });
    this.memory.tick();

    const now = Date.now();
    if (now - this._lastMusicResearchAt >= this.musicResearchIntervalMs) {
      this._lastMusicResearchAt = now;
      await this.music.research({ query: "Kasane Teto SynthV new release 2025" }).catch(() => null);
    }

    const snapshot = this.buildSnapshot();
    if (now - this._lastSoloThoughtAt >= this.soloThoughtIntervalMs) {
      this._lastSoloThoughtAt = now;
      await this.autonomous.tick(snapshot, { useLlm: Boolean(this.autonomous.workerLlm?.generate) });
    } else {
      await this.autonomous.tick(snapshot, { useLlm: false });
    }

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
