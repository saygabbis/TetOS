import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";

export class ReminderStore {
  constructor(path = "./data/reminders.json") {
    this.path = path;
    this.data = readJson(this.path, { reminders: [] });
    this.data.reminders ??= [];
  }

  list(userId = null) {
    const all = [...this.data.reminders];
    if (!userId) return all;
    return all.filter((item) => String(item.userId ?? "") === String(userId));
  }

  create({ userId, text, dueAt = null } = {}) {
    const reminder = {
      id: crypto.randomUUID(),
      userId: String(userId ?? "default"),
      text: String(text ?? "").trim(),
      dueAt,
      createdAt: new Date().toISOString(),
      done: false,
      delivered: false,
      deliveredAt: null,
      deliveryAttempts: 0,
      lastDeliveryAttemptAt: null,
      deliveryError: null
    };
    this.data.reminders.push(reminder);
    writeJson(this.path, this.data);
    return reminder;
  }

  update(id, patch = {}) {
    const reminder = this.data.reminders.find((item) => item.id === id);
    if (!reminder) return null;
    Object.assign(reminder, patch);
    writeJson(this.path, this.data);
    return reminder;
  }

  markDelivered(id, deliveredAt = new Date().toISOString()) {
    return this.update(id, {
      delivered: true,
      deliveredAt,
      deliveryError: null
    });
  }

  markDeliveryAttempt(id, { attemptedAt = new Date().toISOString(), error = null } = {}) {
    const reminder = this.data.reminders.find((item) => item.id === id);
    if (!reminder) return null;
    reminder.deliveryAttempts = Number(reminder.deliveryAttempts ?? 0) + 1;
    reminder.lastDeliveryAttemptAt = attemptedAt;
    reminder.deliveryError = error;
    writeJson(this.path, this.data);
    return reminder;
  }

  markDone(id) {
    const reminder = this.data.reminders.find((item) => item.id === id);
    if (!reminder) return null;
    reminder.done = true;
    reminder.doneAt = new Date().toISOString();
    writeJson(this.path, this.data);
    return reminder;
  }
}
