import { resolveCommand } from "./commandCatalog.js";
import { formatHelp } from "./commandHelp.js";
import { GENERAL_COMMANDS, runGeneralCommand } from "./generalCommands.js";
import { isUrlMediaCommand, toUrlCommand } from "./mediaCommandParser.js";

/** Comandos que precisam de uma mídia do chat (a marcada, a da mensagem ou um message id). */
const TARGET_MEDIA_COMMANDS = new Set([
  "sticker",
  "fsticker",
  "csticker",
  "toimg",
  "optimize",
  "removebg",
  "convert",
  "formatos",
  "transcrever",
  "ler",
  "cortar",
  "gif",
  "comprimir",
  "editar",
  "editarhd"
]);

/** O que a IA não roda sozinha (liga/desliga, conta, coisas da dona…): só a pessoa digitando. */
const NOT_FOR_AGENT = new Set([
  "teto-ativar",
  "teto-desativar",
  "teto-grupo-ativar",
  "teto-grupo-desativar",
  "vincular",
  "desvincular",
  "mente",
  "gastos",
  "viewunica",
  "tetos",
  "repertorio"
]);

const MESSAGE_ID_RE = /^[0-9A-F]{12,40}$/i;

/** Lê o texto de comando que a IA escreveu: ".dado 2d6", "dado 2d6" ou "/dado 2d6". */
export function resolveAgentCommandText(text = "", prefix = ".") {
  const p = prefix || ".";
  let raw = String(text ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (raw.startsWith("/")) raw = raw.slice(1);
  if (!raw.startsWith(p)) raw = `${p}${raw}`;
  const resolved = resolveCommand(raw, p);
  if (!resolved?.cmd || !["known", "corrected"].includes(resolved.kind)) return null;
  return resolved;
}

/**
 * Executa um comando pedido pela IA na conversa (ação `comando(".x args")`), pelo mesmo caminho
 * de quando a pessoa digita — com as mesmas confirmações ("⬇️ baixando…", "✅ pronto").
 *
 * @param {object} p
 * @param {string} p.text texto do comando
 * @param {any} p.runtime
 * @param {any} p.mediaCommands MediaCommandService
 * @param {{ remoteJid: string, userId: string, isGroup?: boolean, isOwner?: boolean, quotedMessageId?: string|null, quotedText?: string|null, messageId?: string|null }} p.item
 * @param {(payload: object) => Promise<any>} p.send
 * @param {(messageId: string) => Promise<{ media: any, source: string } | null>} [p.resolveMedia]
 * @returns {Promise<{ ok: boolean, reason?: string, command?: string }>}
 */
export async function runAgentChatCommand({ text, runtime, mediaCommands, item, send, resolveMedia = null }) {
  const prefix = runtime?.defaults?.commandPrefix ?? ".";
  const resolved = resolveAgentCommandText(text, prefix);
  if (!resolved) return { ok: false, reason: "unknown_command" };
  const cmd = resolved.cmd;
  const name = cmd.name;
  if (NOT_FOR_AGENT.has(name)) return { ok: false, reason: "not_for_agent", command: name };
  if (cmd.scope === "owner" && !item.isOwner) return { ok: false, reason: "owner_only", command: name };
  if (cmd.scope === "pv" && item.isGroup) return { ok: false, reason: "pv_only", command: name };

  const args = resolved.args ?? [];

  if (name === "help") {
    await send({ text: formatHelp(args, prefix, { isOwner: Boolean(item.isOwner), isGroup: Boolean(item.isGroup) }) });
    return { ok: true, command: name };
  }

  if (GENERAL_COMMANDS.has(name)) {
    const out = await runGeneralCommand(resolved, {
      runtime,
      prefix,
      isGroup: Boolean(item.isGroup),
      isOwner: Boolean(item.isOwner),
      userId: item.userId,
      chatId: item.remoteJid,
      quotedText: item.quotedText ?? "",
      receivedAt: Date.now()
    });
    if (out?.voice?.audio) await send({ audio: out.voice.audio, mimetype: "audio/ogg; codecs=opus", ptt: true });
    if (out?.text) await send({ text: out.text });
    return { ok: Boolean(out), command: name };
  }

  if (name === "monitorarpreco") {
    if (!runtime?.priceWatch) return { ok: false, reason: "unavailable", command: name };
    const reply = await runtime.priceWatch.command(resolved.rest ?? "", {
      platform: "whatsapp",
      chatId: item.remoteJid,
      userId: item.userId,
      isGroup: Boolean(item.isGroup),
      say: (msg) => send({ text: msg })
    });
    if (reply) await send({ text: reply });
    return { ok: true, command: name };
  }

  if (!mediaCommands) return { ok: false, reason: "unavailable", command: name };

  if (name === "gerar" || name === "gerarhd") {
    await mediaCommands.handleGenerateImage({ parsedCommand: { command: name, args }, remoteJid: item.remoteJid, userId: item.userId });
    return { ok: true, command: name };
  }

  if (isUrlMediaCommand(name, args)) {
    void mediaCommands
      .handleUrlCommand({ parsedCommand: toUrlCommand({ command: name, args }), remoteJid: item.remoteJid, userId: item.userId })
      .catch((err) => console.warn(`[agent.comando] ${name} falhou:`, err?.message ?? err));
    return { ok: true, command: name };
  }

  if (TARGET_MEDIA_COMMANDS.has(name)) {
    // Message id explícito no 1º argumento; senão a mensagem marcada; senão a própria mensagem.
    const explicitId = args[0] && MESSAGE_ID_RE.test(args[0]) ? args[0] : null;
    const rest = explicitId ? args.slice(1) : args;
    const candidates = [explicitId, item.quotedMessageId, item.messageId].filter(Boolean);
    let target = null;
    let targetId = null;
    for (const id of candidates) {
      target = resolveMedia ? await resolveMedia(id) : null;
      if (target?.media?.path) {
        targetId = id;
        break;
      }
    }
    if (!target?.media?.path) {
      await send({ text: `pra ${prefix}${name} eu preciso de uma mídia: responde a foto/vídeo/áudio/arquivo com o pedido 🙏` });
      return { ok: false, reason: "no_media", command: name };
    }
    void mediaCommands
      .runAgentMediaCommand({
        command: name,
        messageId: targetId,
        args: rest,
        media: target.media,
        remoteJid: item.remoteJid,
        userId: item.userId,
        targetSource: target.source ?? "agent"
      })
      .catch((err) => console.warn(`[agent.comando] ${name} falhou:`, err?.message ?? err));
    return { ok: true, command: name };
  }

  return { ok: false, reason: "unsupported", command: name };
}
