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
    this.unansweredOutreach = new Map();
  }

  touch(userId = "default") {
    this.lastInteractionAt.set(userId, Date.now());
    this.unansweredOutreach.set(userId, 0);
  }

  recordOutbound(userId = "default", evaluation = null) {
    const now = Date.now();
    this.lastNudgeAt.set(userId, now);
    const prev = this.unansweredOutreach.get(userId) ?? 0;
    this.unansweredOutreach.set(userId, prev + 1);
    const suggested = evaluation?.suggestedCooldownMs;
    const cooldown =
      Number.isFinite(suggested) && suggested > 0
        ? Math.min(this.maxCooldownMs, Math.max(this.minCooldownMs, suggested))
        : this.randomCooldownMs();
    this.cooldownByUser.set(userId, cooldown);
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

  maybeInitiate(userId = "default", evaluation = null) {
    if (!evaluation?.shouldInitiate) return null;

    const now = Date.now();
    const sentToday = this.dailySentCount(userId, now);
    if (sentToday >= this.maxDailyPerUser) return null;

    const lastNudge = this.lastNudgeAt.get(userId) ?? 0;
    const cooldown = this.cooldownByUser.get(userId) ?? this.minCooldownMs;
    if (now - lastNudge < cooldown) return null;

    const unanswered = this.unansweredOutreach.get(userId) ?? 0;
    const gapMs = evaluation.gapMs ?? 0;
    if (unanswered >= 1 && gapMs < 3 * 3600_000) return null;
    if (unanswered >= 2 && gapMs < 8 * 3600_000) return null;

    const ghosting = evaluation.ghosting ?? null;
    if (ghosting?.level === "firm" && gapMs < 3 * 3600_000) return null;
    if (ghosting?.level === "heavy") return null;

    const isShortGap = gapMs < 90 * 60 * 1000;
    if (isShortGap) {
      const lastInteraction = this.lastInteractionAt.get(userId) ?? 0;
      if (now - lastInteraction < Math.max(this.inactiveMs, 45 * 60_000)) return null;
    } else if (now - (this.lastInteractionAt.get(userId) ?? 0) < this.inactiveMs) {
      return null;
    }

    if (Math.random() > this.chance && !evaluation.timingPlan?.shouldInitiateConversation) {
      return null;
    }

    return evaluation;
  }

  /** @deprecated use maybeInitiate */
  maybeNudge(userId = "default", _context = {}) {
    return this.maybeInitiate(userId, null);
  }
}
