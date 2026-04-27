import "dotenv/config";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULTS } from "../../infra/config/defaults.js";
import { runMediaRetentionSweep } from "../../infra/media/mediaRetentionSweep.js";
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
  if (!DEFAULTS.replyEnabled) return;
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
  if (!DEFAULTS.replyEnabled) return;
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

function attachChatLedgerListeners(socket, runtime) {
  socket.ev.on("chats.update", (chats = []) => {
    for (const chat of chats) {
      runtime.eventLedger?.append?.({
        eventType: "chat.update",
        remoteJid: chat?.id ?? null,
        unreadCount: chat?.unreadCount ?? null,
        archived: chat?.archive ?? null
      });
    }
  });

  socket.ev.on("groups.update", (groups = []) => {
    for (const group of groups) {
      runtime.eventLedger?.append?.({
        eventType: "group.update",
        remoteJid: group?.id ?? null,
        subject: group?.subject ?? null,
        announce: group?.announce ?? null
      });
    }
  });

  socket.ev.on("group-participants.update", (payload = {}) => {
    runtime.eventLedger?.append?.({
      eventType: "group.participants_update",
      remoteJid: payload?.id ?? null,
      participants: payload?.participants ?? [],
      action: payload?.action ?? null
    });
  });
}

function scheduleAuxiliaryLoops(runtime, nudgeEngine, getSocket, getConnected) {
  if (DEFAULTS.presenceEnabled) {
    setInterval(() => {
      const socket = getSocket();
      if (!getConnected() || !socket) return;
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
    const socket = getSocket();
    if (!getConnected() || !socket) return;
    deliverDueReminders(runtime, socket).catch((error) => {
      console.error("[reminders] delivery error:", error.message);
    });
  }, DEFAULTS.reminderSweepMs);

  if (DEFAULTS.dailyReportEnabled) {
    setInterval(() => {
      const report = runtime.dailyReportGenerator?.maybeGenerateNow?.(
        new Date(),
        DEFAULTS.dailyReportTime
      );
      if (report) {
        runtime.logger?.log?.("learning.daily_report_generated", report);
      }
    }, 30000);
  }

  if (DEFAULTS.mediaRetentionEnabled) {
    const sweep = () =>
      runMediaRetentionSweep({
        mediaRoot: DEFAULTS.whatsappMediaPath,
        maxBytes: DEFAULTS.mediaHotMaxBytes,
        visualAnalysesPath: DEFAULTS.visualAnalysesPath,
        multimodalMemoryPath: DEFAULTS.multimodalMemoryPath,
        logger: runtime.logger
      }).catch((error) => {
        console.error("[media-retention]", error?.message ?? error);
      });
    setTimeout(sweep, 120_000);
    setInterval(sweep, DEFAULTS.mediaRetentionIntervalMs);
  }
}

async function runSingleWhatsApp(runtime, nudgeEngine) {
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
        if (update?.qr) console.log("[whatsapp] QR recebido — escaneie para autenticar");

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

    attachChatLedgerListeners(socket, runtime);
    registerMessageHandler({ socket, runtime, role: "full" });
  };

  await connect();

  scheduleAuxiliaryLoops(runtime, nudgeEngine, () => socket, () => isConnected);
}

async function runDualWhatsApp(runtime, nudgeEngine) {
  let mainSocket = null;
  let mediaSocket = null;
  let mainConnected = false;
  let mediaConnected = false;
  let mainReconnecting = false;
  let mediaReconnecting = false;
  let mainGeneration = 0;
  let mediaGeneration = 0;

  const connectMain = async () => {
    const generation = ++mainGeneration;
    mainSocket = await createBaileysClient({
      sessionPath: DEFAULTS.whatsappSessionPath,
      autoConnect: DEFAULTS.whatsappAutoConnect,
      onConnectionUpdate: async (update) => {
        if (generation !== mainGeneration) return;
        const connection = update?.connection;
        if (connection === "open") {
          mainConnected = true;
          mainReconnecting = false;
          console.log("[whatsapp] main connected (aprendizado / chat)");
        }
        if (update?.qr) {
          console.log("[whatsapp] QR — número principal (aprendizado). Escaneie primeiro se for nova sessão.");
        }

        if (connection === "close" && DEFAULTS.whatsappAutoConnect && !mainReconnecting) {
          mainConnected = false;
          const code = update?.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          const conflict = update?.lastDisconnect?.error?.message?.includes("conflict");
          if (conflict) {
            console.error("[whatsapp] main: conflict — outro processo substituiu esta sessão.");
          }
          if (!loggedOut) {
            mainReconnecting = true;
            try {
              mainSocket?.ws?.close();
            } catch {}
            setTimeout(() => {
              connectMain().catch((error) => {
                mainReconnecting = false;
                console.error("[whatsapp] main reconnect error:", error.message);
              });
            }, 2000);
          }
        }
      }
    });

    mainSocket.ev.on("creds.update", () => console.log("[whatsapp] main creds updated"));
    mainSocket.ev.on("connection.update", (update) => {
      if (update?.lastDisconnect?.error?.message?.includes("bad-request")) {
        console.warn("[whatsapp] main init queries warning: bad-request");
      }
    });

    attachChatLedgerListeners(mainSocket, runtime);
    registerMessageHandler({ socket: mainSocket, runtime, role: "main" });
  };

  const connectMedia = async () => {
    const generation = ++mediaGeneration;
    mediaSocket = await createBaileysClient({
      sessionPath: DEFAULTS.whatsappMediaSessionPath,
      autoConnect: DEFAULTS.whatsappAutoConnect,
      onConnectionUpdate: async (update) => {
        if (generation !== mediaGeneration) return;
        const connection = update?.connection;
        if (connection === "open") {
          mediaConnected = true;
          mediaReconnecting = false;
          console.log("[whatsapp] media connected (.sticker / .toimg)");
        }
        if (update?.qr) {
          console.log("[whatsapp] QR — número só figurinhas. Escaneie com o segundo aparelho/número.");
        }

        if (connection === "close" && DEFAULTS.whatsappAutoConnect && !mediaReconnecting) {
          mediaConnected = false;
          const code = update?.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          const conflict = update?.lastDisconnect?.error?.message?.includes("conflict");
          if (conflict) {
            console.error("[whatsapp] media: conflict — outro processo substituiu esta sessão.");
          }
          if (!loggedOut) {
            mediaReconnecting = true;
            try {
              mediaSocket?.ws?.close();
            } catch {}
            setTimeout(() => {
              connectMedia().catch((error) => {
                mediaReconnecting = false;
                console.error("[whatsapp] media reconnect error:", error.message);
              });
            }, 2000);
          }
        }
      }
    });

    mediaSocket.ev.on("creds.update", () => console.log("[whatsapp] media creds updated"));
    mediaSocket.ev.on("connection.update", (update) => {
      if (update?.lastDisconnect?.error?.message?.includes("bad-request")) {
        console.warn("[whatsapp] media init queries warning: bad-request");
      }
    });

    registerMessageHandler({ socket: mediaSocket, runtime, role: "media" });
  };

  await connectMain();
  await connectMedia();

  scheduleAuxiliaryLoops(runtime, nudgeEngine, () => mainSocket, () => mainConnected);
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

  const dual = DEFAULTS.whatsappMode === "dual";
  if (dual) {
    const absMain = path.resolve(DEFAULTS.whatsappSessionPath);
    const absMedia = path.resolve(DEFAULTS.whatsappMediaSessionPath);
    if (absMain === absMedia) {
      console.error(
        "[whatsapp] dual mode: WHATSAPP_MEDIA_SESSION_PATH must be a folder different from WHATSAPP_SESSION_PATH."
      );
      process.exit(1);
    }
    console.log("[whatsapp] mode=dual — duas sessões (principal + figurinhas). Dois QR se ainda não autenticou.");
  }

  const runtime = createRuntime();
  const nudgeEngine = new NudgeEngine({
    timeStore: runtime.timeStore,
    userPatterns: runtime.userPatterns,
    internalState: runtime.internalState
  });

  if (dual) {
    await runDualWhatsApp(runtime, nudgeEngine);
  } else {
    await runSingleWhatsApp(runtime, nudgeEngine);
  }
}

main().catch((error) => {
  console.error("[whatsapp runner] fatal:", error.message);
  process.exit(1);
});
