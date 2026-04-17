export function buildReminderSummary(reminders, scheduler = null) {
  const all = reminders.list();
  return {
    total: all.length,
    open: all.filter((item) => !item.done).length,
    done: all.filter((item) => item.done).length,
    dueNow: scheduler ? scheduler.due().length : 0,
    pendingDelivery: scheduler ? scheduler.pendingDelivery().length : all.filter((item) => !item.done && item.dueAt && !item.delivered).length,
    delivered: all.filter((item) => item.delivered).length,
    failedDelivery: scheduler
      ? scheduler.failedDelivery().filter((item) => item.deliveryAttempts > 0 && item.deliveryError).length
      : all.filter((item) => !item.done && item.dueAt && !item.delivered && item.deliveryAttempts > 0 && item.deliveryError).length,
    retryBlocked: all.filter((item) => !item.done && !item.delivered && item.deliveryAttempts >= (scheduler?.maxDeliveryAttempts ?? 5)).length,
    lastSweepAt: scheduler?.lastSweepAt ?? null,
    lastDeliverySweepAt: scheduler?.lastDeliverySweepAt ?? null
  };
}
