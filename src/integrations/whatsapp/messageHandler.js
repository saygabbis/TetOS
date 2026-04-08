import { handleIncomingMessage } from "../../app/createRuntime.js";
import { jidNormalizedUser } from "baileys";

function extractPhone(remoteJid = "") {
  return String(remoteJid).replace(/@.+$/, "");
}

function extractText(message = {}) {
  const viewOnce = message?.viewOnceMessage?.message;
  const ephemeral = message?.ephemeralMessage?.message;
  const wrapped = viewOnce ?? ephemeral;
  if (wrapped) return extractText(wrapped);

  return (
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption ??
    message?.buttonsResponseMessage?.selectedButtonId ??
    message?.listResponseMessage?.title ??
    ""
  );
}

export function registerMessageHandler({ socket, runtime }) {
  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;

    for (const incoming of messages ?? []) {
      try {
        if (!incoming?.message) continue;
        if (incoming.key?.fromMe) continue;

        const remoteJidRaw = incoming.key?.remoteJid ?? "";
        const remoteJid = jidNormalizedUser(remoteJidRaw);
        if (!remoteJid || remoteJid.endsWith("@broadcast") || remoteJid === "status@broadcast") {
          continue;
        }

        const text = extractText(incoming.message).trim();
        if (!text) continue;
        console.log(`[whatsapp] incoming ${remoteJid}: ${text}`);

        const userId = extractPhone(remoteJid);
        const sessionId = `wa-${userId}`;
        const profile = runtime.longTerm.getProfile(userId);
        const pushName = incoming.pushName?.trim();

        if (pushName) {
          runtime.longTerm.updateProfile(userId, {
            facts: { ...(profile?.facts ?? {}), name: pushName }
          });
        }

        const { replies } = await handleIncomingMessage(runtime, {
          message: text,
          userId,
          sessionId
        });

        for (const reply of replies ?? []) {
          const content = String(reply ?? "").trim();
          if (!content) continue;
          console.log(`[whatsapp] outgoing ${remoteJid}: ${content}`);
          await socket.sendMessage(remoteJid, { text: content });
        }
      } catch (error) {
        console.error("[whatsapp] message handler error:", error.message);
      }
    }
  });
}
