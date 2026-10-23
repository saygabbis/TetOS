import { existsSync, mkdirSync } from "node:fs";
import { DEFAULTS } from "../../../infra/config/defaults.js";
import { whatsAppStateStore } from "../../../infra/api/whatsapp/WhatsAppStateStore.js";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "baileys";

/**
 * Últimas mensagens que ELA enviou (id → proto). Quando o aparelho de alguém não consegue ler uma
 * mensagem dela, o WhatsApp pede reenvio e a Baileys chama getMessage — sem isso a pessoa ficava
 * com "Aguardando mensagem". Fica fora do socket pra sobreviver a reconexões.
 */
const SENT_CACHE_MAX = 1000;
const sentMessages = new Map();

function rememberSent(messages = []) {
  for (const m of messages) {
    const id = m?.key?.id;
    if (!id || !m.key.fromMe || !m.message) continue;
    sentMessages.delete(id);
    sentMessages.set(id, m.message);
    if (sentMessages.size > SENT_CACHE_MAX) sentMessages.delete(sentMessages.keys().next().value);
  }
}

function ensureSessionDir(sessionPath) {
  if (!existsSync(sessionPath)) {
    mkdirSync(sessionPath, { recursive: true });
  }
}

export async function createBaileysClient({
  sessionPath = DEFAULTS.whatsappSessionPath,
  autoConnect = DEFAULTS.whatsappAutoConnect,
  onConnectionUpdate = null,
  sessionLabel = "whatsapp"
} = {}) {
  ensureSessionDir(sessionPath);
  const { state, saveCreds: saveCredsRaw } = await useMultiFileAuthState(sessionPath);

  const saveCreds = async () => {
    try {
      ensureSessionDir(sessionPath);
      await saveCredsRaw();
    } catch (error) {
      if (error?.code === "ENOENT") {
        ensureSessionDir(sessionPath);
        try {
          await saveCredsRaw();
          return;
        } catch (retryError) {
          console.error("[whatsapp] falha ao salvar credenciais após recriar pasta:", retryError.message);
          return;
        }
      }
      console.error("[whatsapp] falha ao salvar credenciais:", error?.message ?? error);
    }
  };
  const { version } = await fetchLatestBaileysVersion();

  // Antes era 100% mudo: erros reais (ex.: upload de mídia) sumiam. Agora repassa warn/error
  // com filtro de ruído conhecido e no máximo 1 linha igual por minuto.
  const NOISY = /decrypt|Bad MAC|No session|session_cipher|stale|closing (open )?session|prekey|retry receipt|sender key|init queries/i;
  const lastPrinted = new Map();
  const forward = (level) => (obj, msg) => {
    const text = typeof obj === "string" ? obj : msg ?? obj?.msg ?? "";
    if (!text || NOISY.test(text)) return;
    const reason = typeof obj === "object" && obj?.uploadResult ? ` ${JSON.stringify(obj.uploadResult).slice(0, 160)}` : "";
    const line = `[baileys:${sessionLabel}] ${level}: ${String(text).slice(0, 200)}${reason}`;
    const now = Date.now();
    if (now - (lastPrinted.get(line) ?? 0) < 60_000) return;
    lastPrinted.set(line, now);
    console.warn(line);
  };
  const silentLogger = {
    level: "warn",
    child: () => silentLogger,
    trace() {},
    debug() {},
    info() {},
    warn: forward("warn"),
    error: forward("error"),
    fatal: forward("fatal")
  };

  const socket = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    syncFullHistory: false,
    /** linked device: receber mensagens novas sem depender de histórico completo */
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: DEFAULTS.whatsappMarkOnlineOnConnect,
    keepAliveIntervalMs: 10_000,
    logger: silentLogger,
    getMessage: async (key) => sentMessages.get(key?.id) ?? undefined
  });

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("messages.upsert", ({ messages }) => rememberSent(messages));

  socket.ev.on("connection.update", async (update) => {
    if (update?.qr) {
      qrcode.generate(update.qr, { small: true });
      void whatsAppStateStore.setQr(update.qr);
    }

    if (update?.connection === "connecting") {
      whatsAppStateStore.setStatus("connecting");
    }

    if (update?.connection === "open") {
      whatsAppStateStore.setStatus("connected");
      try {
        // Conectar não é "abrir o app": fica offline até ela realmente usar o zap (presenceManager).
        await socket.sendPresenceUpdate(DEFAULTS.whatsappMarkOnlineOnConnect ? "available" : "unavailable");
      } catch {
        // presença opcional — não bloqueia conexão
      }
    }

    if (update?.connection === "close") {
      whatsAppStateStore.setStatus("disconnected");
    }

    if (typeof onConnectionUpdate === "function") {
      onConnectionUpdate(update);
    }

    const { connection } = update;
    if (connection !== "close" || !autoConnect) return;
  });

  return socket;
}
