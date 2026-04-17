import "dotenv/config";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { DEFAULTS } from "../../infra/config/defaults.js";
import { createRuntime } from "../../app/createRuntime.js";
import { NudgeEngine } from "../../core/autonomy/nudgeEngine.js";
import { createBaileysClient } from "./baileysClient.js";
import { registerMessageHandler } from "./messageHandler.js";
import { DisconnectReason } from "baileys";

function listKnownUsers(runtime) {
  const ids = new Set();
  const profiles = runtime.longTerm?.data?.profiles ?? {};
  Object.keys(profiles).forEach((id) => ids.add(id));
  const mediumTerm = runtime.longTerm?.data?.mediumTerm ?? {};
  Object.keys(mediumTerm).forEach((id) => ids.add(id));
  ids.delete("default");
  return [...ids];
}

async function runPresence(runtime, socket, nudgeEngine) {
  if (!DEFAULTS.presenceEnabled) return;
  const users = listKnownUsers(runtime);
  for (const userId of users) {
    const profile = runtime.longTerm.getProfile(userId);
    if (profile?.facts?.lastChannel !== "direct") {
      continue;
    }
    const nudge = nudgeEngine?.buildNudge(userId);
    if (!nudge?.text) continue;
    const allowed = runtime.basicLoop.maybeNudge(userId, {});
    if (!allowed) continue;
    const remoteJid = `${userId}@s.whatsapp.net`;
    const replies = await runtime.chatService.handleMessage(
      nudge.text,
      {
        userId,
        sessionId: `presence-${userId}`,
        styleHint: { conversationEnergy: "low" },
        fallback: "ground"
      },
      null,
      "calm"
    );
    const text = Array.isArray(replies) ? replies[0] : replies;
    if (!text) continue;
    if (!remoteJid.endsWith("@g.us")) {
      await socket.sendMessage(remoteJid, { text });
    }
    runtime.basicLoop.recordOutbound(userId);
    runtime.timeStore?.markSeen(userId);
    runtime.userPatterns?.recordInteraction(userId);
  }
}

function isValidReminderRecipient(userId) {
  const normalized = String(userId ?? "").trim();
  return /^\d+$/.test(normalized) && normalized.length >= 8;
}

async function deliverDueReminders(runtime, socket) {
  const due = runtime.reminderScheduler?.pendingDelivery?.() ?? [];
  runtime.reminderScheduler?.markDeliverySweep?.();
  if (!due.length) return;

  for (const reminder of due) {
    const attemptedAt = new Date().toISOString();
    if (!isValidReminderRecipient(reminder.userId)) {
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

    const remoteJid = `${reminder.userId}@s.whatsapp.net`;
    try {
      await socket.sendMessage(remoteJid, {
        text: `⏰ Lembrete: ${reminder.text}`
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

function suppressNoisyLogs() {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const noisyPatterns = [
    /Failed to decrypt message/i,
    /Bad MAC/i,
    /Session error/i,
    /Closing open session/i,
    /SessionEntry \{/i,
    /creds updated/i
  ];

  const shouldSuppress = (args) => {
    if (!args.length) return false;
    const text = args
      .map((arg) => (typeof arg === "string" ? arg : arg?.message ?? ""))
      .join(" ");
    return noisyPatterns.some((re) => re.test(text));
  };

  const wrapWrite = (original) => (chunk, encoding, cb) => {
    const text = typeof chunk === "string" ? chunk : chunk?.toString?.() ?? "";
    if (noisyPatterns.some((re) => re.test(text))) {
      if (typeof cb === "function") cb();
      return true;
    }
    return original.call(process.stderr, chunk, encoding, cb);
  };

  console.log = (...args) => {
    if (shouldSuppress(args)) return;
    originalLog(...args);
  };
  console.error = (...args) => {
    if (shouldSuppress(args)) return;
    originalError(...args);
  };
  console.warn = (...args) => {
    if (shouldSuppress(args)) return;
    originalWarn(...args);
  };
  process.stderr.write = wrapWrite(process.stderr.write);
  process.stdout.write = wrapWrite(process.stdout.write);
}

async function main() {
  if (!DEFAULTS.whatsappEnabled) {
    console.log("WhatsApp disabled. Set WHATSAPP_ENABLED=true to run.");
    return;
  }

  suppressNoisyLogs();

  const lockPath = ".wa-runner.lock";
  if (existsSync(lockPath)) {
    try {
      const existingPid = Number(readFileSync(lockPath, "utf8"));
      if (existingPid && existingPid !== process.pid) {
        process.kill(existingPid, 0);
        console.error(`[whatsapp] runner already active (pid ${existingPid}). Stop it before starting another.`);
        process.exit(1);
      }
    } catch {
      // stale lock, continue
    }
  }
  writeFileSync(lockPath, String(process.pid));
  process.on("exit", () => {
    try { unlinkSync(lockPath); } catch {}
  });

  const runtime = createRuntime();
  const nudgeEngine = new NudgeEngine({
    timeStore: runtime.timeStore,
    userPatterns: runtime.userPatterns,
    internalState: runtime.internalState
  });
  let socket = null;
  let isConnected = false;
  let reconnecting = false;
  let connectGeneration = 0;

  const connect = async () => {
    const generation = ++connectGeneration;
    socket = await createBaileysClient({
      sessionPath: DEFAULTS.whatsappSessionPath,
      autoConnect: DEFAULTS.whatsappAutoConnect,
      onConnectionUpdate: async (update) => {
        if (generation !== connectGeneration) return;
        const connection = update?.connection;
        if (connection === "open") {
          isConnected = true;
          reconnecting = false;
          console.log("[whatsapp] connected");
        }
        if (update?.qr) console.log("[whatsapp] QR recebido, use o handler de QR");

        if (connection === "close" && DEFAULTS.whatsappAutoConnect && !reconnecting) {
          isConnected = false;
          const code = update?.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          const conflict = update?.lastDisconnect?.error?.message?.includes("conflict");
          if (conflict) {
            console.error("[whatsapp] conflict detected: another session/process replaced this connection.");
          }
          if (!loggedOut) {
            reconnecting = true;
            try {
              socket?.ws?.close();
            } catch {}
            setTimeout(() => {
              connect().catch((error) => {
                reconnecting = false;
                console.error("[whatsapp] reconnect error:", error.message);
              });
            }, 2000);
          }
        }
      }
    });

    socket.ev.on("creds.update", () => {
      console.log("[whatsapp] creds updated");
    });

    socket.ev.on("connection.update", (update) => {
      if (update?.lastDisconnect?.error?.message?.includes("bad-request")) {
        console.warn("[whatsapp] init queries warning: bad-request");
      }
    });

    registerMessageHandler({ socket, runtime });
  };

  await connect();

  if (DEFAULTS.presenceEnabled) {
    setInterval(() => {
      if (!isConnected || !socket) return;
      runPresence(runtime, socket, nudgeEngine).catch((error) => {
        console.error("[presence] error:", error.message);
      });
    }, DEFAULTS.presenceCheckMs);
  }

  setInterval(() => {
    const due = runtime.reminderScheduler?.sweep?.() ?? [];
    if (due.length) {
      runtime.logger?.log?.("reminders.scheduled_due", { count: due.length });
    }
    if (!isConnected || !socket) return;
    deliverDueReminders(runtime, socket).catch((error) => {
      console.error("[reminders] delivery error:", error.message);
    });
  }, DEFAULTS.reminderSweepMs);
}

main().catch((error) => {
  console.error("[whatsapp runner] fatal:", error.message);
  process.exit(1);
});
