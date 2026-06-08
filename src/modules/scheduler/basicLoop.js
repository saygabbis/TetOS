export class BasicLoop {
  constructor({
    inactiveMs = 120000,
    chance = 0.15,
    minCooldownMs = 30 * 60 * 1000,
    maxCooldownMs = 120 * 60 * 1000,
    maxDailyPerUser = 3,
    brainOrchestrator = null,
    timeStore = null,
    userPatterns = null
  } = {}) {
    this.inactiveMs = inactiveMs;
    this.chance = chance;
    this.minCooldownMs = minCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.maxDailyPerUser = maxDailyPerUser;
    this.brainOrchestrator = brainOrchestrator;
    this.timeStore = timeStore;
    this.userPatterns = userPatterns;
    this.lastInteractionAt = new Map();
    this.lastNudgeAt = new Map();
    this.dailyCount = new Map();
    this.cooldownByUser = new Map();
  }

  touch(userId = "default") {
    this.lastInteractionAt.set(userId, Date.now());
  }

  recordOutbound(userId = "default") {
    const now = Date.now();
    this.lastNudgeAt.set(userId, now);
    this.cooldownByUser.set(userId, this.randomCooldownMs());
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const userDaily = this.dailyCount.get(userId) ?? {};
    userDaily[dayKey] = (userDaily[dayKey] ?? 0) + 1;
    this.dailyCount.set(userId, userDaily);
  }

  randomCooldownMs() {
    if (this.maxCooldownMs <= this.minCooldownMs) return this.minCooldownMs;
    const delta = this.maxCooldownMs - this.minCooldownMs;
    return this.minCooldownMs + Math.floor(Math.random() * delta);
  }

  dailySentCount(userId = "default", now = Date.now()) {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const userDaily = this.dailyCount.get(userId) ?? {};
    return userDaily[dayKey] ?? 0;
  }

  buildBrainInitiation(userId = "default") {
    if (!this.brainOrchestrator?.timing) return null;
    const hour = new Date().getHours();
    const emotion = this.brainOrchestrator.emotion?.getSnapshot?.() ?? {};
    const plan = this.brainOrchestrator.timing.computePlan({
      userId,
      channelScope: "direct",
      hourOfDay: hour,
      emotion,
      lastMessageAt: this.timeStore?.getLastMessage?.(userId) ?? null,
      userLikelyActive: this.userPatterns?.isLikelyActiveNow?.(userId) ?? true,
      trustBond: this.brainOrchestrator.enrichTrustForTiming?.(userId, "direct", emotion, hour) ?? null,
      life: this.brainOrchestrator.life?.getSnapshot?.() ?? {},
      sleep: this.brainOrchestrator.life?.sleep?.getSnapshot?.() ?? {}
    });
    if (!plan.shouldInitiateConversation) return null;
    return {
      reason: plan.initiateReason ?? "brain_initiation",
      intent: `Retomar papo (${plan.initiateReason ?? "social_gap"}). ${plan.distanceContext || ""}`.trim(),
      timingPlan: plan,
      brainBlocks: this.brainOrchestrator.narrator?.buildBlocks?.({
        emotion,
        life: this.brainOrchestrator.life?.getSnapshot?.() ?? {},
        trustBond: plan.trustBond,
        timing: plan
      }) ?? null
    };
  }

  chooseIntent(context = {}) {
    if (context?.hasRecentMemory && Math.random() < 0.35) return "memory_recall";
    if (Math.random() < 0.5) return "inactive_user";
    return "curiosity";
  }

  intentForReason(reason) {
    const byIntent = {
      inactive_user: "Reconhecer que a pessoa sumiu um pouco e abrir o papo de forma leve.",
      memory_recall: "Mencionar que lembrou da pessoa e abrir uma pergunta leve.",
      curiosity: "Abrir conversa leve pedindo novidade ou como está."
    };
    return byIntent[reason] ?? byIntent.curiosity;
  }

  maybeNudge(userId = "default", context = {}) {
    const now = Date.now();
    const lastInteraction = this.lastInteractionAt.get(userId) ?? 0;
    if (now - lastInteraction < this.inactiveMs) {
      return null;
    }

    const sentToday = this.dailySentCount(userId, now);
    if (sentToday >= this.maxDailyPerUser) {
      return null;
    }

    const lastNudge = this.lastNudgeAt.get(userId) ?? 0;
    const cooldown = this.cooldownByUser.get(userId) ?? this.minCooldownMs;
    if (now - lastNudge < cooldown) {
      return null;
    }

    const brainNudge = this.buildBrainInitiation(userId);
    if (brainNudge) {
      return { ...brainNudge, text: null };
    }

    if (Math.random() > this.chance) {
      return null;
    }

    const reason = this.chooseIntent(context);
    return { reason, intent: this.intentForReason(reason), text: null };
  }
}
