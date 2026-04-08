export class BasicLoop {
  constructor({
    inactiveMs = 120000,
    chance = 0.15,
    minCooldownMs = 30 * 60 * 1000,
    maxCooldownMs = 120 * 60 * 1000,
    maxDailyPerUser = 3
  } = {}) {
    this.inactiveMs = inactiveMs;
    this.chance = chance;
    this.minCooldownMs = minCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.maxDailyPerUser = maxDailyPerUser;
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

  chooseIntent(context = {}) {
    if (context?.hasRecentMemory && Math.random() < 0.35) return "memory_recall";
    if (Math.random() < 0.5) return "inactive_user";
    return "curiosity";
  }

  textForIntent(intent) {
    const byIntent = {
      inactive_user: ["sumiu", "tá aí?", "oi, tudo bem?"],
      memory_recall: ["lembrei de você agora", "pensei em você rapidinho"],
      curiosity: ["bateu curiosidade: como você tá?", "e aí, novidades?"]
    };
    const options = byIntent[intent] ?? byIntent.curiosity;
    return options[Math.floor(Math.random() * options.length)];
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

    if (Math.random() > this.chance) {
      return null;
    }

    const reason = this.chooseIntent(context);
    const text = this.textForIntent(reason);
    return { reason, text };
  }
}
