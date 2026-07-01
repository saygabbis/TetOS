import { existsSync, mkdirSync } from "node:fs";
import { DEFAULTS } from "../../infra/config/defaults.js";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "baileys";

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

  const silentLogger = {
    level: "silent",
    child: () => silentLogger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {}
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
    logger: silentLogger
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    if (update?.qr) {
      qrcode.generate(update.qr, { small: true });
    }

    if (update?.connection === "open") {
      try {
        await socket.sendPresenceUpdate("available");
      } catch {
        // presença opcional — não bloqueia conexão
      }
    }

    if (typeof onConnectionUpdate === "function") {
      onConnectionUpdate(update);
    }

    const { connection } = update;
    if (connection !== "close" || !autoConnect) return;
  });

  return socket;
}
