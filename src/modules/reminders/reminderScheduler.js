export class ReminderScheduler {
  constructor({ reminders, logger = null, metrics = null, maxDeliveryAttempts = 5, retryDelayMs = 300000 } = {}) {
    this.reminders = reminders;
    this.logger = logger;
    this.metrics = metrics;
    this.maxDeliveryAttempts = maxDeliveryAttempts;
    this.retryDelayMs = retryDelayMs;
    this.lastSweepAt = null;
    this.lastDeliverySweepAt = null;
  }

  due(now = Date.now()) {
    return this.reminders
      .list()
      .filter((item) => !item.done)
      .filter((item) => item.dueAt)
      .filter((item) => new Date(item.dueAt).getTime() <= now);
  }

  canRetry(reminder, now = Date.now()) {
    const attempts = Number(reminder?.deliveryAttempts ?? 0);
    if (attempts >= this.maxDeliveryAttempts) return false;
    if (!reminder?.lastDeliveryAttemptAt) return true;
    const nextAttemptAt = new Date(reminder.lastDeliveryAttemptAt).getTime() + this.retryDelayMs;
    return Number.isFinite(nextAttemptAt) && nextAttemptAt <= now;
  }

  pendingDelivery(now = Date.now()) {
    return this.due(now).filter((item) => !item.delivered && this.canRetry(item, now));
  }

  failedDelivery(now = Date.now()) {
    return this.due(now).filter((item) => !item.delivered && !this.canRetry(item, now));
  }

  sweep(now = Date.now()) {
    const due = this.due(now);
    this.lastSweepAt = new Date(now).toISOString();
    if (due.length) {
      this.logger?.log?.("reminders.due", { count: due.length });
      this.metrics?.increment?.("reminders.due", due.length);
    }
    return due;
  }

  markDeliverySweep(now = Date.now()) {
    this.lastDeliverySweepAt = new Date(now).toISOString();
    return this.lastDeliverySweepAt;
  }
}
