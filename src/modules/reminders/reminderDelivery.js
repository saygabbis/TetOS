import { classifyWaLocalId } from "../../core/channels/waIdentity.js";

/**
 * Para onde entregar: o chat onde o lembrete foi pedido; lembretes antigos (sem chatJid) caem no
 * userId — "dm-<lid>" vira "<lid>@lid", telefone vira "<tel>@s.whatsapp.net".
 */
export function resolveReminderJid(reminder = {}) {
  const chat = String(reminder.chatJid ?? "").trim();
  if (chat.includes("@")) return chat;
  const uid = String(reminder.userId ?? "").trim();
  if (uid.includes("@")) return uid;
  const local = uid.replace(/^dm-/, "");
  if (!/^\d{8,}$/.test(local)) return null;
  return classifyWaLocalId(local) === "phone" ? `${local}@s.whatsapp.net` : `${local}@lid`;
}

/** Entrega lembretes vencidos no chat onde foram pedidos; registra tentativas e erros. */
export async function deliverDueReminders(runtime, socket, { replyEnabled = true } = {}) {
  if (!replyEnabled) return;
  const due = runtime.reminderScheduler?.pendingDelivery?.() ?? [];
  runtime.reminderScheduler?.markDeliverySweep?.();
  if (!due.length) return;

  for (const reminder of due) {
    const attemptedAt = new Date().toISOString();
    const remoteJid = resolveReminderJid(reminder);
    if (!remoteJid) {
      runtime.reminders?.markDeliveryAttempt?.(reminder.id, {
        attemptedAt,
        error: "invalid_recipient"
      });
      runtime.logger?.log?.("reminders.delivery_skipped", {
        reminderId: reminder.id,
        userId: reminder.userId,
        reason: "invalid_recipient"
      });
      runtime.metrics?.increment?.("reminders.delivery_skipped");
      continue;
    }

    try {
      await socket.sendMessage(remoteJid, {
        text: `⏰ ei, lembrete: ${reminder.text}`
      });
      runtime.reminders?.markDeliveryAttempt?.(reminder.id, { attemptedAt });
      runtime.reminders?.markDelivered?.(reminder.id, attemptedAt);
      runtime.logger?.log?.("reminders.delivered", {
        reminderId: reminder.id,
        userId: reminder.userId
      });
      runtime.metrics?.increment?.("reminders.delivered");
    } catch (error) {
      runtime.reminders?.markDeliveryAttempt?.(reminder.id, {
        attemptedAt,
        error: error.message
      });
      runtime.logger?.log?.("reminders.delivery_error", {
        reminderId: reminder.id,
        userId: reminder.userId,
        error: error.message
      });
      runtime.metrics?.increment?.("reminders.delivery_error");
    }
  }
}

