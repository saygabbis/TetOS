import "dotenv/config";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULTS } from "../../infra/config/defaults.js";
import { runMediaRetentionSweep } from "../../infra/media/mediaRetentionSweep.js";
import { sweepMindLogRetention } from "../../infra/mindLogRetention.js";
import { createRuntime } from "../../app/createRuntime.js";
import { createBaileysClient } from "./baileysClient.js";
import { registerMessageHandler } from "./messageHandler.js";
import { DisconnectReason } from "baileys";
import { isUserRecentlyActive, resolveNudgeRemoteJid, touchUserActivity } from "../../core/channels/userActivity.js";
import { msSinceLastInbound, resetInboundActivity } from "./inboundLiveness.js";
import { jidNormalizedUser } from "baileys";

/** Pausa nudges/presence após 403 de assinatura (evita spam a cada 60s). */
let presenceLlmPausedUntil = 0;
let presenceSubscriptionWarned = false;

function isOllamaSubscriptionError(message = "") {
  const msg = String(message);
  return /403/.test(msg) && /subscription|upgrade/i.test(msg);
}

/** Reconecta após queda — retenta até voltar, sem múltiplos loops paralelos. */
function formatSocketJid(socket) {
  return jidNormalizedUser(socket?.user?.id ?? socket?.user?.jid ?? "") || "?";
}

/**
 * Baileys pode ficar "surdo": connection=open mas messages.upsert para.
 * Desligado por padrão (0) — idle normal não deve derrubar o bot (vida/cérebro/nudges).
 * Ative com WHATSAPP_INBOUND_STALE_MS>=60000 se quiser reconnect em socket surdo real.
 */
function startInboundWatchdog({ getConnected, label = "whatsapp", onDeaf = null }) {
  const staleMs = Number(process.env.WHATSAPP_INBOUND_STALE_MS ?? 0);
  const checkMs = Number(process.env.WHATSAPP_INBOUND_CHECK_MS ?? 30000);
  if (!Number.isFinite(staleMs) || staleMs < 60000) return;

  let recovering = false;
  setInterval(() => {
    if (!getConnected()) {
      resetInboundActivity();
      return;
    }
    const silentMs = msSinceLastInbound({ botOnly: label.includes("bot") });
    if (silentMs < staleMs) return;
    const silentMin = Math.round(silentMs / 60000);
    console.error(
      `[${label}] socket surdo — conectado mas sem mensagens há ${silentMin} min. ` +
        "Celular da bot nao pode ter WhatsApp aberto junto; reconectando..."
    );
    if (typeof onDeaf === "function") {
      if (recovering) return;
      recovering = true;
      Promise.resolve(onDeaf())
        .catch((error) => {
          console.error(`[${label}] falha ao reconectar socket surdo:`, error?.message ?? error);
        })
        .finally(() => {
          recovering = false;
          resetInboundActivity();
        });
      return;
    }
    console.warn(
      `[${label}] socket surdo detectado mas sem handler de reconexao — mantendo processo ativo. ` +
        "Defina WHATSAPP_INBOUND_STALE_MS=0 para silenciar ou passe onDeaf no runner."
    );
    resetInboundActivity();
  }, checkMs);
}

function scheduleWhatsAppReconnect({ label, onClose, connect, state }) {
  if (state?.active) {
    console.warn(`[whatsapp] ${label}: reconexão já em andamento`);
    return;
  }
  if (state) state.active = true;

  let attempts = 0;
  const tryConnect = () => {
    attempts += 1;
    const delayMs = Math.min(30_000, 2000 + attempts * 2000);
    console.warn(`[whatsapp] ${label}: reconectando em ${Math.round(delayMs / 1000)}s (tentativa ${attempts})`);
    setTimeout(() => {
      connect().catch((error) => {
        console.error(`[whatsapp] ${label} reconnect error:`, error.message);
        tryConnect();
      });
    }, delayMs);
  };

  onClose();
  tryConnect();
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

async function runPresence(runtime, socket, initiationEngine) {
  if (!DEFAULTS.replyEnabled) return;
  if (!DEFAULTS.presenceEnabled) return;
  if (Date.now() < presenceLlmPausedUntil) return;
  const users = listKnownUsers(runtime);
  for (const userId of users) {
    const profile = runtime.longTerm.getProfile(userId);
    const dmOnlyInGroup =
      profile?.facts?.lastChannel === "group" &&
      runtime.tetoActivation?.isActivationRequired?.() &&
      !runtime.tetoActivation.isDmActive(userId);
    if (dmOnlyInGroup) {
      continue;
    }
    if (runtime.tetoActivation?.isActivationRequired?.() && !runtime.tetoActivation.isDmActive(userId)) {
      continue;
    }

    const boundary = runtime.longTerm.getProfile(userId)?.facts ?? {};
    const boundaryUntil = boundary.userBoundaryUntil ? Date.parse(boundary.userBoundaryUntil) : 0;
    if (Number.isFinite(boundaryUntil) && boundaryUntil > Date.now()) continue;

    const sleepSnap = runtime.brainOrchestrator?.life?.sleep?.getSnapshot?.() ?? {};
    if (sleepSnap.isAvailable === false) continue;

    const hour = new Date().getHours();
    if (hour >= 0 && hour < 7) continue;

    const evaluation = initiationEngine?.evaluateForUser?.(userId);
    if (!evaluation?.shouldInitiate) continue;

    const isQueued = Boolean(evaluation.queueEntryId);
    if (
      !isQueued &&
      isUserRecentlyActive(runtime, userId, DEFAULTS.presenceInactiveMs)
    ) {
      continue;
    }

    const allowed = runtime.basicLoop.maybeInitiate(userId, evaluation);
    if (!allowed) continue;

    const sessionId = evaluation.sessionId;
    const history = runtime.shortTerm?.getAll?.(sessionId)?.slice(-12) ?? [];
    const remoteJid = resolveNudgeRemoteJid(runtime, userId);
    const tone = evaluation.tone ?? "playful";
    const seedMessage =
      String(evaluation.impulse ?? evaluation.threadHint ?? "").trim() ||
      "Manda uma mensagem curta e natural pro usuario (iniciativa da Teto).";

    const replies = await runtime.chatService.handleMessage(
      seedMessage,
      {
        userId,
        sessionId,
        styleHint: { conversationEnergy: evaluation.mode?.includes("lull") ? "low" : "medium" },
        fallback: "ground",
        timingPlan: evaluation.timingPlan ?? null,
        brainBlocks: evaluation.brainBlocks ?? null,
        brainSnapshot: evaluation.brainSnapshot ?? null,
        isInitiative: true,
        initiationContext: evaluation,
        recentHistory: history
      },
      history,
      tone
    );

    const parts = Array.isArray(replies) ? replies.filter(Boolean) : replies ? [replies] : [];
    if (!parts.length) continue;

    if (!remoteJid.endsWith("@g.us")) {
      if (typeof socket.sendPresenceUpdate === "function") {
        try {
          await socket.sendPresenceUpdate("composing", remoteJid);
          const thinkMs = evaluation.timingPlan?.thinkDelayMs ?? 1200;
          await new Promise((r) => setTimeout(r, Math.min(thinkMs, 4000) + Math.floor(Math.random() * 800)));
          await socket.sendPresenceUpdate("paused", remoteJid);
        } catch {
          /* ignore */
        }
      }
      for (const text of parts) {
        await socket.sendMessage(remoteJid, { text });
        if (parts.length > 1) {
          await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 900)));
        }
      }
    }

    if (evaluation.queueEntryId) {
      initiationEngine?.markSent?.(evaluation.queueEntryId);
    }
    runtime.basicLoop?.recordOutbound?.(userId, evaluation);
    touchUserActivity(runtime, userId, { markMessage: false, sessionId });
    runtime.timeStore?.markAssistantMessage?.(userId, Date.now(), sessionId);
    runtime.brainOrchestrator?.recordAssistantOutput?.(sessionId, parts.join("\n"), {
      initiative: true,
      mode: evaluation.mode
    });
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
  const lifeTickMs = Number(process.env.TETOS_LIFE_TICK_MS ?? 900000);
  if (runtime.brainOrchestrator?.life?.tick && Number.isFinite(lifeTickMs) && lifeTickMs >= 120000) {
    setInterval(() => {
      try {
        runtime.brainOrchestrator.life.tick({
          emotion: runtime.brainOrchestrator.emotion?.getSnapshot?.() ?? {}
        });
      } catch (error) {
        console.warn("[life] tick error:", error?.message ?? error);
      }
    }, lifeTickMs);
  }

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

  if (DEFAULTS.mindLogEnabled && DEFAULTS.mindLogRetentionDays > 0) {
    const sweepMindLog = () => {
      try {
        const result = sweepMindLogRetention(DEFAULTS.mindLogPath, DEFAULTS.mindLogRetentionDays);
        if (result.removed > 0) {
          console.log(`[mind-log] retencao: removidos ${result.removed}, mantidos ${result.kept}`);
        }
      } catch (error) {
        console.error("[mind-log] retencao:", error?.message ?? error);
      }
    };
    setTimeout(sweepMindLog, 180_000);
    setInterval(sweepMindLog, 6 * 60 * 60 * 1000);
  }
}

async function runSingleWhatsApp(runtime, nudgeEngine) {
  let socket = null;
  let isConnected = false;
  let reconnecting = false;
  const reconnectState = { active: false };
  let connectGeneration = 0;

  const connect = async () => {
    const generation = ++connectGeneration;
    socket = await createBaileysClient({
      sessionPath: DEFAULTS.whatsappSessionPath,
      autoConnect: DEFAULTS.whatsappAutoConnect,
      sessionLabel: "single",
      onConnectionUpdate: async (update) => {
        if (generation !== connectGeneration) return;
        const connection = update?.connection;
        if (connection === "open") {
          isConnected = true;
          reconnecting = false;
          reconnectState.active = false;
          resetInboundActivity();
          console.log(`[whatsapp] connected — jid=${formatSocketJid(socket)}`);
        }
        if (update?.qr) console.log("[whatsapp] QR recebido — escaneie para autenticar");

        if (connection === "close" && DEFAULTS.whatsappAutoConnect) {
          isConnected = false;
          const code = update?.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          const conflict = update?.lastDisconnect?.error?.message?.includes("conflict");
          if (conflict) {
            console.error("[whatsapp] conflict detected: another session/process replaced this connection.");
          }
          if (loggedOut) {
            reconnecting = false;
            reconnectState.active = false;
            console.error("[whatsapp] logged out — escaneie o QR novamente");
            return;
          }
          scheduleWhatsAppReconnect({
            label: "single",
            state: reconnectState,
            onClose: () => {
              reconnecting = true;
              try {
                socket?.ws?.close();
              } catch {}
            },
            connect
          });
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
  startInboundWatchdog({
    label: "whatsapp",
    getConnected: () => isConnected,
    onDeaf: async () => {
      console.warn("[whatsapp] reconectando sessão por possível socket surdo...");
      isConnected = false;
      try {
        socket?.end?.(new Error("inbound stale reconnect"));
      } catch {}
      await connect();
    }
  });
}

async function runDualWhatsApp(runtime, nudgeEngine) {
  let mainSocket = null;
  let mediaSocket = null;
  let mainConnected = false;
  let mediaConnected = false;
  let mainReconnecting = false;
  let mediaReconnecting = false;
  const mainReconnectState = { active: false };
  const mediaReconnectState = { active: false };
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
      sessionLabel: "main",
      onConnectionUpdate: async (update) => {
        if (generation !== mainGeneration) return;
        const connection = update?.connection;
        if (connection === "open") {
          mainConnected = true;
          mainReconnecting = false;
          mainReconnectState.active = false;
          resetInboundActivity();
          const jid = formatSocketJid(mainSocket);
          console.log(
            DEFAULTS.whatsappMainObserveOnly
              ? `[whatsapp] main connected — jid=${jid} — SEU número: lê chats e aprende (sem responder).`
              : `[whatsapp] main connected — jid=${jid} — número que lê chats, aprende e responde.`
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

        if (connection === "close" && DEFAULTS.whatsappAutoConnect) {
          mainConnected = false;
          const code = update?.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          const conflict = update?.lastDisconnect?.error?.message?.includes("conflict");
          if (conflict) {
            console.error("[whatsapp] main: conflict — outro processo substituiu esta sessão.");
          }
          if (loggedOut) {
            mainReconnecting = false;
            mainReconnectState.active = false;
            console.error("[whatsapp] main logged out — escaneie o QR novamente");
            return;
          }
          scheduleWhatsAppReconnect({
            label: "main",
            state: mainReconnectState,
            onClose: () => {
              mainReconnecting = true;
              try {
                mainSocket?.ws?.close();
              } catch {}
            },
            connect: connectMain
          });
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
      sessionLabel: "bot",
      onConnectionUpdate: async (update) => {
        if (generation !== mediaGeneration) return;
        const connection = update?.connection;
        if (connection === "open") {
          mediaConnected = true;
          mediaReconnecting = false;
          mediaReconnectState.active = false;
          resetInboundActivity();
          const jid = formatSocketJid(mediaSocket);
          console.log(
            DEFAULTS.whatsappMainObserveOnly
              ? `[whatsapp] bot connected — jid=${jid} — número da TETO: chat, .sticker e .toimg`
              : `[whatsapp] media connected — jid=${jid} — número só para comandos .sticker / .toimg`
          );
          if (DEFAULTS.whatsappMainObserveOnly) {
            const botPhone = jid.replace(/@.+$/, "").replace(/:\d+$/, "");
            runtime.whatsappBotPhoneE164 = botPhone;
            console.log(
              `[whatsapp:media] Para acordar a Teto, mande DM para +${botPhone} (não para o seu número pessoal).`
            );
          }
        }
        if (update?.qr) {
          console.log(
            DEFAULTS.whatsappMainObserveOnly
              ? "[whatsapp] 2/2 — QR do número da TETO/BOT. Escaneie com o chip/SIM do bot (não o seu pessoal)."
              : "[whatsapp] 2/2 — QR do número só COMANDOS DE MÍDIA (.sticker, .toimg). Pode escanear com o segundo telefone/número."
          );
        }

        if (connection === "close" && DEFAULTS.whatsappAutoConnect) {
          mediaConnected = false;
          const code = update?.lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          const conflict = update?.lastDisconnect?.error?.message?.includes("conflict");
          if (conflict) {
            console.error("[whatsapp] media: conflict — outro processo substituiu esta sessão.");
          }
          if (loggedOut) {
            mediaReconnecting = false;
            mediaReconnectState.active = false;
            console.error("[whatsapp] media logged out — escaneie o QR novamente");
            return;
          }
          scheduleWhatsAppReconnect({
            label: "media",
            state: mediaReconnectState,
            onClose: () => {
              mediaReconnecting = true;
              try {
                mediaSocket?.ws?.close();
              } catch {}
            },
            connect: connectMedia
          });
        }
      }
    });

    mediaSocket.ev.on("creds.update", () => console.log("[whatsapp] media creds updated"));
    mediaSocket.ev.on("connection.update", (update) => {
      if (update?.lastDisconnect?.error?.message?.includes("bad-request")) {
        console.warn("[whatsapp] media init queries warning: bad-request");
      }
    });

    attachChatLedgerListeners(mediaSocket, runtime);
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
  startInboundWatchdog({
    label: "whatsapp:main",
    getConnected: () => mainConnected,
    onDeaf: async () => {
      console.warn("[whatsapp:main] reconectando sessão principal (aprendizado)...");
      mainConnected = false;
      try {
        mainSocket?.end?.(new Error("inbound stale reconnect"));
      } catch {}
      await connectMain();
    }
  });
  startInboundWatchdog({
    label: "whatsapp:bot",
    getConnected: chatConnected,
    onDeaf: async () => {
      console.warn("[whatsapp:bot] reconectando sessão da Teto por inatividade de mensagens...");
      mediaConnected = false;
      try {
        mediaSocket?.end?.(new Error("inbound stale reconnect"));
      } catch {}
      await connectMedia();
    }
  });
}

async function main() {
  if (!DEFAULTS.whatsappEnabled) {
    console.log("WhatsApp disabled. Set WHATSAPP_ENABLED=true to run.");
    return;
  }

  suppressNoisyLogs();

  process.on("unhandledRejection", (reason) => {
    const msg = String(reason?.message ?? reason ?? "");
    if (/ENOENT.*creds\.json/i.test(msg) || /ENOENT.*session/i.test(msg)) {
      console.error("[whatsapp] rejeição não tratada (sessão):", msg);
      return;
    }
    console.error("[whatsapp] rejeição não tratada:", reason);
  });

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
  const initiationEngine = runtime.initiationEngine;

  if (dual) {
    await runDualWhatsApp(runtime, initiationEngine);
  } else {
    await runSingleWhatsApp(runtime, initiationEngine);
  }
}

main().catch((error) => {
  console.error("[whatsapp runner] fatal:", error.message);
  process.exit(1);
});
