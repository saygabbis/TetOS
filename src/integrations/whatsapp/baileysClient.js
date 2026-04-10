import { mkdirSync } from "node:fs";
import { DEFAULTS } from "../../infra/config/defaults.js";
import qrcode from "qrcode-terminal";
import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "baileys";

export async function createBaileysClient({
  sessionPath = DEFAULTS.whatsappSessionPath,
  autoConnect = DEFAULTS.whatsappAutoConnect,
  onConnectionUpdate = null
} = {}) {
  mkdirSync(sessionPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const socket = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true,
    syncFullHistory: false
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", async (update) => {
    if (update?.qr) {
      qrcode.generate(update.qr, { small: true });
    }

    if (typeof onConnectionUpdate === "function") {
      onConnectionUpdate(update);
    }

    const { connection } = update;
    if (connection !== "close" || !autoConnect) return;
  });

  return socket;
}
