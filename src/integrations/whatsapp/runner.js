import "dotenv/config";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULTS } from "../../infra/config/defaults.js";
import { createRuntime } from "../../app/createRuntime.js";
import { createBaileysClient } from "./connection/baileysClient.js";
import { registerMessageHandler } from "./inbound/messageHandler.js";
import { DisconnectReason } from "baileys";
import { msSinceLastInbound, resetInboundActivity } from "./connection/inboundLiveness.js";
import { jidNormalizedUser } from "baileys";
import { scheduleAuxiliaryLoops } from "./loops/auxiliaryLoops.js";
import { startConnectionProbe } from "./connection/connectionProbe.js";
import { startDiscordBot } from "../discord/discordBot.js";

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

function bindWhatsAppSocketBridge(runtime, getSocket, getConnected) {
  runtime.whatsappGetSocket = getSocket;
  runtime.whatsappIsConnected = getConnected;
  runtime.whatsappWaitConnected = (timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const ready = () => {
        const live = getSocket();
        return Boolean(getConnected() && live?.user);
      };
      if (ready()) {
        resolve(getSocket());
        return;
      }
      const started = Date.now();
      const timer = setInterval(() => {
        if (ready()) {
          clearInterval(timer);
          resolve(getSocket());
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("whatsapp reconnect timeout"));
        }
      }, 200);
    });
  console.log("[whatsapp] outbound retry após reconexão ativo");
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

async function runSingleWhatsApp(runtime) {
  let socket = null;
  let isConnected = false;
  const reconnectState = { active: false };
  let connectGeneration = 0;
  bindWhatsAppSocketBridge(runtime, () => socket, () => isConnected);

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
            reconnectState.active = false;
            console.error("[whatsapp] logged out — escaneie o QR novamente");
            return;
          }
          scheduleWhatsAppReconnect({
            label: "single",
            state: reconnectState,
            onClose: () => {
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
    runtime.whatsappSockets ??= {};
    runtime.whatsappSockets.full = socket;
    registerMessageHandler({ socket, runtime, role: "full" });
  };

  await connect();

  scheduleAuxiliaryLoops(runtime, () => socket, () => isConnected);
  // Recria a conexão; a geração avança antes do end() para o "close" do socket velho não
  // disparar um segundo reconnect em paralelo (dois sockets com a mesma sessão = conflito).
  const forceReconnect = async (reason) => {
    console.warn(`[whatsapp] reconectando: ${reason}`);
    isConnected = false;
    connectGeneration += 1;
    try {
      socket?.end?.(new Error(reason));
    } catch {}
    await connect();
  };
  startInboundWatchdog({
    label: "whatsapp",
    getConnected: () => isConnected,
    onDeaf: () => forceReconnect("possível socket surdo")
  });
  startConnectionProbe({
    label: "whatsapp",
    getSocket: () => socket,
    getConnected: () => isConnected,
    onDead: () => forceReconnect("sonda sem resposta")
  });
}

async function runDualWhatsApp(runtime) {
  let mainSocket = null;
  let mediaSocket = null;
  let mainConnected = false;
  let mediaConnected = false;
  const mainReconnectState = { active: false };
  const mediaReconnectState = { active: false };
  let mainGeneration = 0;
  let mediaGeneration = 0;
  bindWhatsAppSocketBridge(
    runtime,
    DEFAULTS.whatsappMainObserveOnly ? () => mediaSocket : () => mainSocket,
    DEFAULTS.whatsappMainObserveOnly ? () => mediaConnected : () => mainConnected
  );

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
            mainReconnectState.active = false;
            console.error("[whatsapp] main logged out — escaneie o QR novamente");
            return;
          }
          scheduleWhatsAppReconnect({
            label: "main",
            state: mainReconnectState,
            onClose: () => {
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
    runtime.whatsappSockets ??= {};
    runtime.whatsappSockets.main = mainSocket;
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
            mediaReconnectState.active = false;
            console.error("[whatsapp] media logged out — escaneie o QR novamente");
            return;
          }
          scheduleWhatsAppReconnect({
            label: "media",
            state: mediaReconnectState,
            onClose: () => {
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
    runtime.whatsappSockets ??= {};
    runtime.whatsappSockets.media = mediaSocket;
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
  scheduleAuxiliaryLoops(runtime, chatSocket, chatConnected);
  const reconnectMain = async (reason) => {
    console.warn(`[whatsapp:main] reconectando sessão principal: ${reason}`);
    mainConnected = false;
    mainGeneration += 1;
    try {
      mainSocket?.end?.(new Error(reason));
    } catch {}
    await connectMain();
  };
  const reconnectMedia = async (reason) => {
    console.warn(`[whatsapp:bot] reconectando sessão da Teto: ${reason}`);
    mediaConnected = false;
    mediaGeneration += 1;
    try {
      mediaSocket?.end?.(new Error(reason));
    } catch {}
    await connectMedia();
  };
  startInboundWatchdog({ label: "whatsapp:main", getConnected: () => mainConnected, onDeaf: () => reconnectMain("possível socket surdo") });
  startInboundWatchdog({ label: "whatsapp:bot", getConnected: chatConnected, onDeaf: () => reconnectMedia("inatividade de mensagens") });
  startConnectionProbe({ label: "whatsapp:main", getSocket: () => mainSocket, getConnected: () => mainConnected, onDead: () => reconnectMain("sonda sem resposta") });
  startConnectionProbe({ label: "whatsapp:bot", getSocket: () => mediaSocket, getConnected: () => mediaConnected, onDead: () => reconnectMedia("sonda sem resposta") });
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
  // Estado desconhecido após exceção não capturada: sai (gravações pendentes são salvas no exit)
  // e o supervisor (scripts/supervisor.js) religa limpo.
  process.on("uncaughtException", (error) => {
    console.error("[whatsapp] exceção não capturada — encerrando para religar:", error?.stack ?? error);
    process.exit(1);
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
  // Deixa o Whisper local baixado/carregado antes do 1º áudio chegar.
  setTimeout(() => void runtime.audioTranscriber?.warmup?.().catch(() => {}), 20_000).unref();
  // Discord no mesmo processo (mesma memória/vida); se falhar, o zap segue normal.
  void startDiscordBot(runtime).catch((error) => console.error("[discord] não subiu:", error?.message ?? error));

  if (dual) {
    await runDualWhatsApp(runtime);
  } else {
    await runSingleWhatsApp(runtime);
  }
}

main().catch((error) => {
  console.error("[whatsapp runner] fatal:", error.message);
  process.exit(1);
});
