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
    const nudge = nudgeEngine?.buildNudge(userId);
    if (!nudge?.text) continue;
    const allowed = runtime.basicLoop.maybeNudge(userId, {});
    if (!allowed) continue;
    const remoteJid = `${userId}@s.whatsapp.net`;
    await socket.sendMessage(remoteJid, { text: nudge.text });
    runtime.basicLoop.recordOutbound(userId);
    runtime.timeStore?.markSeen(userId);
    runtime.userPatterns?.recordInteraction(userId);
  }
}

async function main() {
  if (!DEFAULTS.whatsappEnabled) {
    console.log("WhatsApp disabled. Set WHATSAPP_ENABLED=true to run.");
    return;
  }

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
        if (update?.qr) console.log("[whatsapp] scan QR in terminal");

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
}

main().catch((error) => {
  console.error("[whatsapp runner] fatal:", error.message);
  process.exit(1);
});
