import { jidNormalizedUser, downloadContentFromMessage } from "baileys";
import { isOwnerContact, resolveNudgeRemoteJid } from "../../core/channels/userActivity.js";
import {
  extractViewOnceInner,
  isViewOnceMessage,
  isViewOnceStub,
  viewOnceCaption,
  viewOnceMediaKind
} from "./viewOnceDetect.js";

const FORWARD_DEDUPE_MAX = 500;

function extractPhone(remoteJid = "") {
  return String(remoteJid ?? "")
    .replace(/@.+$/, "")
    .replace(/:\d+$/, "");
}

function sessionLabel(role = "full") {
  if (role === "main") return "seu número (aprendizado)";
  if (role === "media") return "número da Teto";
  return "sessão única";
}

export function resolveAdminNotifyJid(runtime) {
  const ownerJids = runtime?.defaults?.ownerWaJids ?? [];
  if (ownerJids[0]) return jidNormalizedUser(ownerJids[0]);

  const phone = String(runtime?.defaults?.learningTargetUserId ?? "").trim();
  if (phone) return jidNormalizedUser(`${phone}@s.whatsapp.net`);

  const adminId = String(runtime?.defaults?.adminUserId ?? "").trim();
  if (adminId) return jidNormalizedUser(resolveNudgeRemoteJid(runtime, adminId));

  return null;
}

export class ViewOnceMirrorService {
  constructor({ store, runtime } = {}) {
    this.store = store;
    this.runtime = runtime;
    this.forwardedIds = new Set();
  }

  isAdmin(userId, remoteJid) {
    const isOwner = isOwnerContact(this.runtime, remoteJid, userId);
    if (isOwner) return true;
    return Boolean(this.runtime?.operationRouter?.isAdmin?.(userId, { isOwner }));
  }

  pickSendSocket() {
    const sockets = this.runtime?.whatsappSockets ?? {};
    if (sockets.media?.sendMessage) return sockets.media;
    if (sockets.full?.sendMessage) return sockets.full;
    if (sockets.main?.sendMessage) return sockets.main;
    return null;
  }

  parseCommand(text = "", prefix = ".") {
    const raw = String(text ?? "").trim();
    if (!raw.startsWith(prefix)) return null;
    const body = raw.slice(prefix.length).trim();
    if (!body) return null;
    const [cmdRaw, ...args] = body.split(/\s+/);
    const cmd = String(cmdRaw ?? "").toLowerCase();
    if (!["viewunica", "viewonce", "view-unica"].includes(cmd)) return null;
    return { command: "viewunica", args };
  }

  handleCommand({ userId, remoteJid, args = [] } = {}) {
    if (!this.isAdmin(userId, remoteJid)) {
      return { handled: true, reply: null, forbidden: true };
    }
    const token = String(args[0] ?? "status").trim().toLowerCase();
    if (["on", "ligar", "ativar", "1", "sim"].includes(token)) {
      this.store?.enable?.(userId);
      return {
        handled: true,
        reply: "view única espelhada ATIVA — vou te mandar no PV o que chegar de visualização única (seu número ou da Teto)"
      };
    }
    if (["off", "desligar", "desativar", "0", "nao", "não"].includes(token)) {
      this.store?.disable?.();
      return { handled: true, reply: "view única espelhada desativada" };
    }
    return { handled: true, reply: this.store?.statusLine?.() ?? "view única indisponível" };
  }

  rememberForward(messageId) {
    const id = String(messageId ?? "").trim();
    if (!id) return false;
    if (this.forwardedIds.has(id)) return false;
    this.forwardedIds.add(id);
    if (this.forwardedIds.size > FORWARD_DEDUPE_MAX) {
      const drop = [...this.forwardedIds].slice(0, FORWARD_DEDUPE_MAX / 2);
      for (const key of drop) this.forwardedIds.delete(key);
    }
    return true;
  }

  buildInfoText({
    incoming,
    remoteJid,
    userId,
    pushName,
    role,
    isGroup,
    hasMedia,
    caption
  }) {
    const who = pushName ? `${pushName} (${userId})` : String(userId ?? "?");
    const chat = isGroup ? `grupo ${remoteJid}` : `PV ${extractPhone(remoteJid)}`;
    const lines = [
      "📸 *View once espelhada*",
      `De: ${who}`,
      `Chat: ${chat}`,
      `Conta que recebeu: ${sessionLabel(role)}`,
      `Msg id: ${incoming?.key?.id ?? "?"}`
    ];
    if (caption) lines.push(`Legenda: ${caption}`);
    if (!hasMedia) {
      lines.push(
        "",
        "⚠️ WhatsApp não entregou a mídia nesta sessão (linked device). Só deu pra avisar que chegou view once."
      );
    }
    return lines.join("\n");
  }

  async downloadViewOnceMedia(rawMessage = {}) {
    const inner = extractViewOnceInner(rawMessage);
    if (!inner) return null;
    const kind = viewOnceMediaKind(inner);
    if (!kind) return null;

    const content = inner.imageMessage ?? inner.videoMessage ?? inner.audioMessage;
    if (!content) return null;

    const decryptAs = kind === "audio" ? "audio" : kind === "image" ? "image" : "video";
    try {
      const stream = await downloadContentFromMessage(content, decryptAs);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      if (buffer.byteLength < 16) return null;
      return { buffer, kind, mimetype: content.mimetype ?? null };
    } catch (error) {
      console.warn("[viewonce:mirror] download failed:", error?.message ?? error);
      return null;
    }
  }

  async mirrorIncoming({
    incoming,
    rawMessage,
    role = "full",
    remoteJid,
    userId,
    pushName,
    isGroup,
    fallbackText = "",
    receiveSocket = null
  } = {}) {
    if (!this.store?.isEnabled?.()) return false;
    if (incoming?.key?.fromMe) return false;

    const viewOnce =
      isViewOnceMessage(rawMessage, incoming?.key) || isViewOnceStub(incoming);
    if (!viewOnce) return false;

    const messageId = incoming?.key?.id;
    if (!this.rememberForward(messageId)) return false;

    const adminJid = resolveAdminNotifyJid(this.runtime);
    if (!adminJid) {
      console.warn("[viewonce:mirror] admin jid não configurado (LEARNING_TARGET_USER_ID / TETOS_OWNER_WA_JID)");
      return false;
    }

    const sendSocket = this.pickSendSocket() ?? receiveSocket;
    if (!sendSocket?.sendMessage) {
      console.warn("[viewonce:mirror] nenhum socket WhatsApp disponível para encaminhar");
      return false;
    }

    const inner = extractViewOnceInner(rawMessage);
    const caption = viewOnceCaption(inner, fallbackText);
    const downloaded = await this.downloadViewOnceMedia(rawMessage);

    const infoText = this.buildInfoText({
      incoming,
      remoteJid,
      userId,
      pushName,
      role,
      isGroup,
      hasMedia: Boolean(downloaded?.buffer),
      caption
    });

    try {
      await sendSocket.sendMessage(adminJid, { text: infoText });
      if (downloaded?.buffer) {
        const payload =
          downloaded.kind === "audio"
            ? {
                audio: downloaded.buffer,
                mimetype: downloaded.mimetype ?? "audio/ogg; codecs=opus",
                ptt: Boolean(inner?.audioMessage?.ptt)
              }
            : downloaded.kind === "video" || downloaded.kind === "gif"
              ? {
                  video: downloaded.buffer,
                  mimetype: downloaded.mimetype ?? "video/mp4",
                  gifPlayback: downloaded.kind === "gif"
                }
              : {
                  image: downloaded.buffer,
                  mimetype: downloaded.mimetype ?? "image/jpeg"
                };
        await sendSocket.sendMessage(adminJid, payload);
      }
      console.log(
        `[viewonce:mirror] encaminhado msg=${messageId} role=${role} admin=${adminJid} media=${Boolean(downloaded?.buffer)}`
      );
      return true;
    } catch (error) {
      console.error("[viewonce:mirror] send failed:", error?.message ?? error);
      return false;
    }
  }
}
