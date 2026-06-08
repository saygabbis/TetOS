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
import { isUserRecentlyActive, resolveNudgeRemoteJid, touchUserActivity } from "../../core/channels/userActivity.js";

/** Pausa nudges/presence após 403 de assinatura (evita spam a cada 60s). */
let presenceLlmPausedUntil = 0;
let presenceSubscriptionWarned = false;

function isOllamaSubscriptionError(message = "") {
  const msg = String(message);
  return /403/.test(msg) && /subscription|upgrade/i.test(msg);
}

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
  if (Date.now() < presenceLlmPausedUntil) return;
  const users = listKnownUsers(runtime);
  for (const userId of users) {
    const profile = runtime.longTerm.getProfile(userId);
    if (profile?.facts?.lastChannel !== "direct") {
      continue;
    }
    if (runtime.tetoActivation?.isActivationRequired?.() && !runtime.tetoActivation.isDmActive(userId)) {
      continue;
    }
    if (isUserRecentlyActive(runtime, userId, DEFAULTS.presenceInactiveMs)) {
      continue;
    }
    const nudge = nudgeEngine?.buildNudge(userId);
    if (!nudge?.intent) continue;
    const allowed = runtime.basicLoop.maybeNudge(userId, {});
    if (!allowed) continue;
    const effectiveNudge = allowed.intent ? allowed : nudge;
    const remoteJid = resolveNudgeRemoteJid(runtime, userId);
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "9518ce" },
      body: JSON.stringify({
        sessionId: "9518ce",
        hypothesisId: "H2",
        location: "runner.js:runPresence:before-llm",
        message: "presence nudge calling LLM",
        data: { userId, model: DEFAULTS.model },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    const replies = await runtime.chatService.handleMessage(
      "",
      {
        userId,
        sessionId: `presence-${userId}`,
        styleHint: { conversationEnergy: "low" },
        fallback: "ground",
        timingPlan: effectiveNudge.timingPlan ?? null,
        brainBlocks: effectiveNudge.brainBlocks ?? null,
        isNudge: true,
        nudgeIntent: effectiveNudge.intent ?? allowed.intent
      },
      null,
      "calm"
    );
    const text = Array.isArray(replies) ? replies[0] : replies;
    if (!text) continue;
    if (!remoteJid.endsWith("@g.us")) {
      if (typeof socket.sendPresenceUpdate === "function") {
        try {
          await socket.sendPresenceUpdate("composing", remoteJid);
          await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 600)));
          await socket.sendPresenceUpdate("paused", remoteJid);
        } catch {
          /* ignore */
        }
      }
      await socket.sendMessage(remoteJid, { text });
    }
    touchUserActivity(runtime, userId, { markMessage: false });
    runtime.timeStore?.markSeen(userId);
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
    runtime.channelRegistry?.syncGroupParticipants?.(
      payload?.id,
      payload?.participants ?? [],
      payload?.action === "remove" ? "remove" : "add"
    );
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
        const msg = String(error?.message ?? "");
        if (isOllamaSubscriptionError(msg)) {
          presenceLlmPausedUntil = Date.now() + 6 * 60 * 60 * 1000;
          if (!presenceSubscriptionWarned) {
            presenceSubscriptionWarned = true;
            console.error(
              `[presence] ${DEFAULTS.model} exige Pro na Ollama Cloud (403). Chat também falha com este modelo. Use gpt-oss:20b-cloud no free ou assine Pro. Nudges pausados 6h.`
            );
          }
        } else {
          console.error("[presence] error:", msg);
        }
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

  /** Só o arranque: a segunda sessão só arranca depois do principal estar `open`. */
  let resolveMainBootstrap = null;
  const mainBootstrapReady = new Promise((r) => {
    resolveMainBootstrap = r;
  });
  const notifyMainBootstrapOnline = () => {
    const fn = resolveMainBootstrap;
    resolveMainBootstrap = null;
    fn?.();
  };

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
          console.log(
            DEFAULTS.whatsappMainObserveOnly
              ? "[whatsapp] main connected — SEU número: lê chats e aprende (sem responder)."
              : "[whatsapp] main connected — número que lê chats, aprende e responde."
          );
          notifyMainBootstrapOnline();
        }
        if (update?.qr) {
          console.log(
            DEFAULTS.whatsappMainObserveOnly
              ? "[whatsapp] 1/2 — QR do SEU número (só aprendizado). Escaneie com seu WhatsApp pessoal."
              : "[whatsapp] 1/2 — QR do número PRINCIPAL (lê mensagens e aprende). Escaneie só este até conectar; o QR do bot vem depois."
          );
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
          console.log(
            DEFAULTS.whatsappMainObserveOnly
              ? "[whatsapp] bot connected — número da TETO: chat, .sticker e .toimg"
              : "[whatsapp] media connected — número só para comandos .sticker / .toimg"
          );
        }
        if (update?.qr) {
          console.log(
            DEFAULTS.whatsappMainObserveOnly
              ? "[whatsapp] 2/2 — QR do número da TETO/BOT. Escaneie com o chip/SIM do bot (não o seu pessoal)."
              : "[whatsapp] 2/2 — QR do número só COMANDOS DE MÍDIA (.sticker, .toimg). Pode escanear com o segundo telefone/número."
          );
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
  await mainBootstrapReady;
  console.log(
    DEFAULTS.whatsappMainObserveOnly
      ? "[whatsapp] Seu número online (aprendizado). Próximo QR = número da TETO para responder no chat."
      : "[whatsapp] Principal online. A iniciar a sessão só de comandos de mídia — o próximo QR é do bot de .sticker / .toimg."
  );
  await connectMedia();

  const chatSocket = DEFAULTS.whatsappMainObserveOnly ? () => mediaSocket : () => mainSocket;
  const chatConnected = DEFAULTS.whatsappMainObserveOnly
    ? () => mediaConnected
    : () => mainConnected;
  scheduleAuxiliaryLoops(runtime, nudgeEngine, chatSocket, chatConnected);
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
    if (DEFAULTS.whatsappMainObserveOnly) {
      console.log(
        "[whatsapp] mode=dual — 1º QR = SEU número (só aprende, não responde); 2º QR = número da TETO/bot (chat + .sticker/.toimg)."
      );
    } else {
      console.log(
        "[whatsapp] mode=dual — primeiro QR = número que aprende/responde; só depois de conectar aparece o QR do número de .sticker/.toimg."
      );
    }
  }

  const runtime = createRuntime();
  const nudgeEngine = new NudgeEngine({
    timeStore: runtime.timeStore,
    userPatterns: runtime.userPatterns,
    internalState: runtime.internalState,
    brainOrchestrator: runtime.brainOrchestrator
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
