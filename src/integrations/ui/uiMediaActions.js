import { publishAssistantTyping } from "../../infra/api/ui/uiEventPublishers.js";
import { UiMediaError, UI_MEDIA_COMMANDS } from "./uiMediaService.js";
import { resolveThreadMediaRef } from "./uiMediaStore.js";
import {
  formatWhatsAppHelpText,
  isUrlMediaCommand,
  parseWhatsAppCommand
} from "../whatsapp/mediaCommandParser.js";

/** Tipos de ação do agente que a UI sabe executar (equivalem aos do WhatsApp). */
export const UI_MEDIA_ACTION_TYPES = Object.freeze([
  "sticker",
  "media",
  "toimage",
  "url_download",
  "generate_image",
  "save_sticker",
  "repertoire_mode",
  "react"
]);

export function isUiMediaAction(action) {
  return UI_MEDIA_ACTION_TYPES.includes(action?.type);
}

let seq = 0;
function nextId(prefix = "a") {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

/** Publica uma bolha da Teto (texto e/ou mídias) na thread. */
export function pushAssistantMessage({ thread, uiBus, text = "", attachments = [] }) {
  const message = {
    id: nextId("a"),
    role: "assistant",
    text,
    createdAt: new Date().toISOString(),
    ...(attachments.length ? { attachments } : {})
  };
  thread.messages.push(message);
  thread.updatedAt = message.createdAt;
  uiBus.publish({ type: "message.final", threadId: thread.id, message });
  return message;
}

function reportError({ thread, uiBus }, error) {
  const text = error instanceof UiMediaError ? error.message : `Falha ao processar a mídia: ${error?.message ?? error}`;
  pushAssistantMessage({ thread, uiBus, text });
}

async function withTyping(ctx, fn) {
  publishAssistantTyping(ctx.uiBus, ctx.thread.id, true);
  try {
    return await fn();
  } finally {
    publishAssistantTyping(ctx.uiBus, ctx.thread.id, false);
  }
}

function deliver(ctx, { attachments, notes = [], caption = "" }) {
  const text = [caption, ...notes].filter(Boolean).join("\n");
  // Figurinhas/mídias saem sozinhas; notas viram uma bolha curta à parte.
  pushAssistantMessage({ thread: ctx.thread, uiBus: ctx.uiBus, attachments });
  if (text) pushAssistantMessage({ thread: ctx.thread, uiBus: ctx.uiBus, text });
}

/**
 * Roda um comando de mídia sobre uma mídia da thread (equivale a `.sticker`, `.toimg`, `.removebg`...).
 * `mediaRef` pode ser message id da UI, `mediaId` ou vazio para "última mídia".
 */
export async function runUiMediaCommand(ctx, { command, args = [], mediaRef = null }) {
  const ref = resolveThreadMediaRef(ctx.thread, mediaRef, { skipMessageId: ctx.skipMessageId ?? null });
  return withTyping(ctx, async () => {
    try {
      const result = await ctx.service.runMediaCommand({ command, args, ref });
      deliver(ctx, result);
      return true;
    } catch (error) {
      reportError(ctx, error);
      return false;
    }
  });
}

export async function runUiUrlDownload(ctx, { command, url, args = [] }) {
  return withTyping(ctx, async () => {
    try {
      const result = await ctx.service.runUrlDownload({ command, url, args });
      deliver(ctx, result);
      return true;
    } catch (error) {
      reportError(ctx, error);
      return false;
    }
  });
}

export async function runUiGenerateImage(ctx, { prompt, caption = "" }) {
  return withTyping(ctx, async () => {
    try {
      const result = await ctx.service.generateImage({ prompt, userId: ctx.userId });
      deliver(ctx, { ...result, caption });
      return true;
    } catch (error) {
      reportError(ctx, error);
      return false;
    }
  });
}

export async function runUiSaveSticker(ctx, { mediaRef = null, key = null, label = null }) {
  const ref = resolveThreadMediaRef(ctx.thread, mediaRef, { skipMessageId: ctx.skipMessageId ?? null });
  return withTyping(ctx, async () => {
    try {
      const saved = await ctx.service.saveToRepertoire({ ref, key, label, userId: ctx.userId });
      const name = saved.displayName ? `${saved.displayName} (${saved.key})` : saved.key;
      pushAssistantMessage({ thread: ctx.thread, uiBus: ctx.uiBus, text: `salvei no repertório como ${name}` });
      return true;
    } catch (error) {
      reportError(ctx, error);
      return false;
    }
  });
}

function reactToLastUserMessage(ctx, emoji) {
  const target = [...ctx.thread.messages].reverse().find((m) => m.role === "user");
  if (!target || !emoji) return false;
  target.meta = { ...(target.meta ?? {}), reaction: String(emoji) };
  ctx.uiBus.publish({ type: "message.final", threadId: ctx.thread.id, message: target });
  return true;
}

/**
 * Executa uma ação do agente (a mesma que o WhatsApp roda) na interface.
 * @returns {Promise<boolean>} true se a ação era de mídia e foi tratada.
 */
export async function applyUiMediaAction(ctx, action) {
  switch (action?.type) {
    case "sticker": {
      const attachment = ctx.service.stickerAttachment(action.key);
      if (attachment) pushAssistantMessage({ thread: ctx.thread, uiBus: ctx.uiBus, attachments: [attachment] });
      return true;
    }
    case "media":
    case "toimage":
      await runUiMediaCommand(ctx, {
        command: action.command ?? "toimg",
        args: action.args ?? [],
        mediaRef: action.messageId
      });
      return true;
    case "url_download":
      await runUiUrlDownload(ctx, { command: action.command, url: action.url, args: action.args ?? [] });
      return true;
    case "generate_image":
      await runUiGenerateImage(ctx, { prompt: action.prompt, caption: action.caption ?? "" });
      return true;
    case "save_sticker":
      await runUiSaveSticker(ctx, { mediaRef: action.messageId, key: action.key, label: action.label });
      return true;
    case "repertoire_mode":
      ctx.service.setRepertoireMode(ctx.userId, Boolean(action.enabled));
      return true;
    case "react":
      reactToLastUserMessage(ctx, action.emoji);
      return true;
    default:
      return false;
  }
}

function repertoireCommand(ctx, args) {
  const sub = String(args?.[0] ?? "status").toLowerCase();
  const say = (text) => pushAssistantMessage({ thread: ctx.thread, uiBus: ctx.uiBus, text });

  if (["on", "ligar", "ativar", "true", "1"].includes(sub)) {
    ctx.service.setRepertoireMode(ctx.userId, true);
    say("modo repertório: ATIVO — figurinhas que você enviar aqui são salvas automaticamente.");
    return true;
  }
  if (["off", "desligar", "desativar", "false", "0"].includes(sub)) {
    ctx.service.setRepertoireMode(ctx.userId, false);
    say("modo repertório: inativo.");
    return true;
  }
  if (["listar", "lista", "list"].includes(sub)) {
    const stickers = ctx.service.listStickers();
    say(
      stickers.length
        ? `repertório (${stickers.length}): ${stickers.map((s) => s.key).join(", ")}`
        : "o repertório está vazio."
    );
    return true;
  }
  if (["salvar", "save", "adicionar"].includes(sub)) {
    return { save: true, key: args?.[1] ?? null };
  }
  if (["remover", "remove", "apagar", "delete"].includes(sub)) {
    const key = args?.[1];
    if (!key) {
      say("diga qual figurinha remover: .repertorio remover <chave>");
      return true;
    }
    const result = ctx.service.removeSticker(key);
    say(
      result.ok
        ? `tirei ${result.key} do repertório.`
        : result.reason === "builtin"
          ? "essa figurinha é padrão e não pode ser removida."
          : "não achei essa figurinha no repertório."
    );
    return true;
  }
  say(
    ctx.service.isRepertoireModeOn(ctx.userId)
      ? "modo repertório: ATIVO (figurinhas enviadas aqui são salvas automaticamente)."
      : 'modo repertório: inativo — use .repertorio on. Também: .repertorio listar | salvar [chave] | remover <chave>.'
  );
  return true;
}

/**
 * Interpreta comandos com prefixo digitados na interface (`.sticker`, `.yt <link>`, `.gerar ...`).
 * @returns {Promise<boolean>} true quando o texto era um comando e foi executado (não chamar o LLM).
 */
export async function tryHandleUiCommand(ctx, text) {
  const prefix = ctx.runtime?.defaults?.commandPrefix ?? ".";
  const parsed = parseWhatsAppCommand(text, prefix);
  if (!parsed) return false;
  const { command, args } = parsed;

  if (command === "help") {
    pushAssistantMessage({ thread: ctx.thread, uiBus: ctx.uiBus, text: formatWhatsAppHelpText(prefix) });
    return true;
  }
  if (command === "repertorio") {
    const outcome = repertoireCommand(ctx, args);
    if (outcome?.save) {
      await runUiSaveSticker(ctx, { mediaRef: null, key: outcome.key });
    }
    return true;
  }
  if (command === "gerar") {
    const prompt = args.join(" ").trim();
    if (!prompt) {
      pushAssistantMessage({ thread: ctx.thread, uiBus: ctx.uiBus, text: `uso: ${prefix}gerar <descrição da imagem>` });
      return true;
    }
    await runUiGenerateImage(ctx, { prompt });
    return true;
  }
  if (isUrlMediaCommand(command)) {
    const url = args.find((a) => /^https?:\/\//i.test(a));
    await runUiUrlDownload(ctx, { command, url, args: args.filter((a) => a !== url) });
    return true;
  }
  if (UI_MEDIA_COMMANDS.includes(command)) {
    await runUiMediaCommand(ctx, { command, args, mediaRef: null });
    return true;
  }
  return false;
}

/** Salva figurinhas enviadas pelo usuário quando o modo repertório está ligado. */
export async function autoSaveIncomingStickers(ctx, attachments = []) {
  if (!ctx.service.isRepertoireModeOn(ctx.userId)) return [];
  const saved = [];
  for (const att of attachments) {
    if (att.kind !== "sticker" || !att.mediaId) continue;
    try {
      saved.push(await ctx.service.saveToRepertoire({ ref: att, userId: ctx.userId }));
    } catch {
      /* auto-save é best-effort */
    }
  }
  if (saved.length) {
    pushAssistantMessage({
      thread: ctx.thread,
      uiBus: ctx.uiBus,
      text: `salvei no repertório: ${saved.map((s) => s.key).join(", ")}`
    });
  }
  return saved;
}
