import { existsSync, readFileSync } from "node:fs";
import { handleIncomingMessage } from "../../app/createRuntime.js";
import { withGenerationSlot } from "../../infra/concurrency/generationSlot.js";
import { touchInboundActivity } from "./inboundLiveness.js";
import { jidNormalizedUser, downloadContentFromMessage, normalizeMessageContent } from "baileys";
import { planWhatsAppReaction } from "./reactionPlanner.js";
import { persistMedia, fileExtFromDocumentMessage } from "./mediaStore.js";
import { resolvePassiveModeAction } from "../../core/channels/passiveModeAction.js";
import { RESPONSE_MODES, RESPONSE_OUTPUTS } from "../../core/pipeline/responseModes.js";
import {
  addDecisionStep,
  createDecisionTrace,
  finalizeDecisionTrace
} from "../../infra/observability/decisionTrace.js";
import { resolveStickerAsset } from "./stickerAssets.js";
import { ChatService, resolveOutgoingActions, sanitizeOutgoingActions } from "../../modules/chat/chatService.js";
import { resolveCloseDecision } from "../../core/brain/ConversationPhaseEngine.js";
import { detectWrongBotNameVocative } from "./tetoNameDetect.js";
import { hasVocativeToTeto } from "../../modules/chat/coherenceGuards.js";
import { detectVulnerability } from "../../core/brain/vulnerabilityDetect.js";
import { ChatCommandQueue } from "./chatCommandQueue.js";
import { ChatMediaHistoryStore } from "./chatMediaHistoryStore.js";
import { resolveCommandTarget } from "./commandTargetResolver.js";
import { isAnimatedRemoveBgTarget, MediaProcessor } from "../../core/media/mediaProcessor.js";
import { probeStickerIsAnimated } from "../../core/media/stickerAnimation.js";
import { detectConfirmationReply } from "../../core/operations/confirmationIntent.js";
import { formatMediaInputText } from "../../core/channels/mediaTimelineEnrich.js";
import { resolveStickerDurationArg } from "../../core/media/stickerDurationParse.js";
import {
  REMOVE_BG_MODEL_LABELS,
  resolveRemoveBgOptions
} from "../../core/media/removeBgOptionsParse.js";
import { resolveTimingConfig, estimateTypingDelayMs as estimateTypingFromCfg } from "../../core/timing/timingConfig.js";
import { ChatMessageIndex } from "./chatMessageIndex.js";
import {
  applyQuotedContextToPayload,
  botMentionedInJids,
  buildOutgoingQuoteKey,
  classifyTetoAddress,
  extractContextInfo,
  extractQuotedText,
  isQuotedMessageFromBot,
  shouldQuoteOutgoing,
  resolveOutgoingQuoteId,
  buildQuoteKeyFromMessageId
} from "./messageContext.js";
import { resolveVerifiedQuoteKey } from "./quoteMessageResolver.js";
import { buildBotActorIds } from "../../core/channels/botIdentity.js";
import {
  parseTetoSlashCommand,
  handleTetoSlashCommand,
  formatTetoActivationCommand
} from "./tetoSlashCommands.js";
import {
  parseTetosCommand,
  resolveTetosMessage,
  formatTetosUsage,
  isQuotedTetosOneShot
} from "./tetosCommand.js";
import {
  formatWhatsAppHelpText as formatMediaCommandHelpText,
  parseWhatsAppCommand as parseMediaCommand
} from "./mediaCommandParser.js";
import { buildWhatsappIdentitySnapshot } from "./whatsappIdentityContract.js";
import { MediaCommandService } from "./mediaCommandService.js";
import { buildWaDocumentPayload, buildWaGifPlaybackPayload } from "./waMediaPayload.js";
import { resolveMediaByMessageId } from "./agentMediaResolver.js";
import {
  saveStickerToRepertoire,
  saveStickerToRepertoireWithVision,
  tryAutoSaveIncomingSticker,
  isForwardedMessage,
  logRepertoireVision,
  findRepertoireEntryByMessageId,
  removeStickerFromRepertoire,
  isBuiltinRepertoireKey
} from "./stickerRepertoire.js";
import {
  canonicalSessionId,
  canonicalUserId,
  isOwnerContact,
  resolveOwnerActorId
} from "../../core/channels/userActivity.js";
import {
  buildIdentityIndex,
  cleanDisplayName,
  extractLocalPart,
  isLikelyPhoneNumber,
  normalizeIncomingMentions,
  recordWaIdentity
} from "../../core/channels/waIdentity.js";
import { buildGroupRoster } from "../../core/channels/groupRoster.js";
import { translateAtMentions } from "./mentionResolver.js";
import { createProcessedCommandDeduper } from "./processedCommandDeduper.js";
import { shouldRespondToMediaOnly } from "../../core/media/mediaSpamGate.js";
import { isViewOnceMessage, isViewOnceStub } from "./viewOnceDetect.js";
import { isGroupPriorityEntry } from "./groupTurnPlanner.js";
import {
  compactGroupQueueSegments,
  planFloodAwareGroupSegments
} from "./groupFloodCoordinator.js";
import {
  scoreSleepDisturbance,
  sleepDisturbanceFloodWindowMs
} from "../../core/life/sleepDisturbanceDetect.js";

function extractPhone(remoteJid = "") {
  return String(remoteJid)
    .replace(/@.+$/, "")
    .replace(/:\d+$/, "");
}

/** Alinha ao Baileys: documento com legenda vem em `documentWithCaptionMessage`, não só em `documentMessage`. */
function unwrapMessage(message = {}) {
  const normalized = normalizeMessageContent(message);
  return normalized ?? message ?? {};
}

function extractText(message = {}) {
  const unwrapped = unwrapMessage(message);
  return (
    unwrapped?.conversation ??
    unwrapped?.extendedTextMessage?.text ??
    unwrapped?.imageMessage?.caption ??
    unwrapped?.videoMessage?.caption ??
    unwrapped?.documentMessage?.caption ??
    unwrapped?.stickerMessage?.fileName ??
    unwrapped?.buttonsResponseMessage?.selectedButtonId ??
    unwrapped?.listResponseMessage?.title ??
    ""
  );
}

function extractLinks(text = "") {
  const matches = String(text).match(/https?:\/\/[^\s]+/gi);
  return matches ? [...new Set(matches)] : [];
}

function classifyContent(text = "") {
  const lower = String(text ?? "").toLowerCase();
  if (!lower.trim()) return "empty";
  if (/(nsfw|18\+|porn|nude|putaria|sexo|xxx)/i.test(lower)) return "sensitive_nsfw";
  return "general";
}

function logThinking(runtime, payload = {}) {
  const {
    phase = "unknown",
    userId = "unknown",
    remoteJid = "unknown",
    detail = ""
  } = payload;
  const detailText = String(detail ?? "").trim();
  if (!runtime?.defaults?.thinkingLogsEnabled) return;
  console.log(
    `[thinking] phase=${phase} user=${userId} chat=${remoteJid}${detailText ? ` detail="${detailText}"` : ""}`
  );
}

function detectMediaKind(unwrappedMessage = {}) {
  if (unwrappedMessage?.audioMessage) return "audio";
  if (unwrappedMessage?.imageMessage) return "image";
  if (unwrappedMessage?.videoMessage?.gifPlayback) return "gif";
  if (unwrappedMessage?.videoMessage) return "video";
  if (unwrappedMessage?.stickerMessage) return "sticker";
  if (unwrappedMessage?.documentMessage) {
    const mime = String(unwrappedMessage.documentMessage?.mimetype ?? "").toLowerCase();
    if (/^image\//.test(mime)) return "image";
    if (/^video\//.test(mime)) return "video";
    return "document";
  }
  return "text";
}

function buildIncomingAudit(payload = {}) {
  const {
    remoteJid,
    userId,
    isGroup,
    text,
    links,
    media,
    quotedMessage,
    isReply,
    isDirectMention,
    mentionHint,
    closeDecision,
    messageId,
    participantId,
    pushName
  } = payload;
  return {
    ts: new Date().toISOString(),
    remoteJid,
    userId,
    participantId: participantId || null,
    pushName: pushName || null,
    isGroup: Boolean(isGroup),
    messageId: messageId || null,
    text: text || "",
    links: Array.isArray(links) ? links : [],
    mediaType: media?.type ?? "none",
    mediaPath: media?.path ?? null,
    mediaCaption: media?.caption ?? null,
    mediaTranscript: media?.transcript ?? null,
    isReply: Boolean(isReply),
    quotedMessage: quotedMessage || null,
    isDirectMention: Boolean(isDirectMention),
    mentionCount: Array.isArray(mentionHint) ? mentionHint.length : 0,
    closeDecision: closeDecision || null
  };
}

function logIncomingAudit(runtime, payload = {}) {
  if (!runtime?.defaults?.thinkingLogsEnabled) return;
  const audit = buildIncomingAudit(payload);
  console.log(`[audit.incoming] ${JSON.stringify(audit)}`);
}

function logOutgoingAudit(runtime, payload = {}) {
  if (!runtime?.defaults?.thinkingLogsEnabled) return;
  const audit = buildIncomingAudit(payload);
  console.log(`[audit.outgoing] ${JSON.stringify(audit)}`);
}

function inferEditReason(beforeText = "", afterText = "") {
  const before = String(beforeText ?? "").trim();
  const after = String(afterText ?? "").trim();
  if (!before && after) return "complemento";
  if (before && !after) return "limpeza";
  if (before.toLowerCase() === after.toLowerCase() && before !== after) return "formatacao";
  if (Math.abs(before.length - after.length) <= 3) return "correcao_rapida";
  if (after.length > before.length) return "detalhamento";
  if (after.length < before.length) return "resumo";
  return "nao_informado";
}

function buildMessageSnapshot({ messageId, remoteJid, actorId, text, mediaType, quotedMessage }) {
  return {
    messageId: messageId ?? null,
    remoteJid: remoteJid ?? null,
    actorId: actorId ?? null,
    text: String(text ?? ""),
    mediaType: mediaType ?? null,
    quotedMessage: quotedMessage ?? null,
    ts: new Date().toISOString()
  };
}

const WA_MESSAGE_CACHE_MAX = 250;

function rememberWaMessage(cache, incoming, rawMessage) {
  const id = incoming?.key?.id;
  if (!id || !cache) return;
  cache.set(id, {
    key: { ...incoming.key },
    message: rawMessage ?? incoming?.message ?? {},
    messageTimestamp: incoming.messageTimestamp ?? Date.now()
  });
  if (cache.size > WA_MESSAGE_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

function extractUpdatedText(update = {}) {
  const msg = update?.update?.message;
  if (!msg) return "";
  return extractText(msg).trim();
}

function parseWhatsAppCommand(text = "", prefix = ".") {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith(prefix)) return null;
  const withoutPrefix = raw.slice(prefix.length).trim();
  if (!withoutPrefix) return null;
  const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
  const command = String(cmdRaw ?? "").toLowerCase();
  const aliases = {
    stiker: "sticker",
    fstiker: "fsticker",
    cstiker: "csticker",
    ajuda: "help",
    comandos: "help",
    commands: "help",
    otimizar: "optimize",
    optimizar: "optimize",
    rmbg: "removebg",
    "remove-bg": "removebg",
    rep: "repertorio",
    repertorio: "repertorio"
  };
  const normalized = aliases[command] ?? command;
  if (!["sticker", "fsticker", "csticker", "toimg", "optimize", "removebg", "help", "repertorio"].includes(normalized)) {
    return null;
  }
  return { command: normalized, args };
}

function repertoireModeReplyText(store, userId, arg = "") {
  const token = String(arg ?? "").trim().toLowerCase();
  if (["on", "ligar", "ativar", "1", "sim"].includes(token)) {
    store?.enable?.(userId);
    return "modo repertório ATIVO — figurinhas que você mandar ou encaminhar vão pro meu repertório automaticamente";
  }
  if (["off", "desligar", "desativar", "0", "nao", "não"].includes(token)) {
    store?.disable?.(userId);
    return "modo repertório desativado";
  }
  return store?.statusLine?.(userId) ?? "modo repertório indisponível";
}

function isRepertorioRemoveSubcommand(parsedCommand) {
  const sub = String(parsedCommand?.args?.[0] ?? "").trim().toLowerCase();
  return ["remover", "remove", "rm", "deletar", "apagar"].includes(sub);
}

function formatRepertoireEntryLabel(entry = {}) {
  if (entry.displayName) return `${entry.displayName} (${entry.key})`;
  return entry.key ?? "figurinha";
}

async function handleRepertorioRemoveCommand({
  runtime,
  remoteJid,
  userId,
  stanzaId,
  send
}) {
  const basePath = runtime.defaults.stickersPath;
  if (!stanzaId) {
    await send(
      "marca a figurinha (reply/quote) e manda .repertorio remover — preciso saber qual é"
    );
    return;
  }

  const entry = findRepertoireEntryByMessageId(basePath, stanzaId);
  if (!entry?.key) {
    await send("essa figurinha não tá no meu repertório kkk");
    return;
  }
  if (isBuiltinRepertoireKey(entry.key)) {
    await send("essa é figurinha padrão minha, não dá pra tirar do repertório");
    return;
  }

  runtime.pendingConfirmations?.create?.({
    userId,
    type: "repertoire_remove",
    payload: {
      messageId: stanzaId,
      key: entry.key,
      remoteJid,
      displayName: entry.displayName ?? null
    }
  });

  const label = formatRepertoireEntryLabel(entry);
  await send(
    `a figurinha ${label} tá no repertório... quer remover mesmo? manda sim ou não`
  );
}

async function tryHandleRepertoireRemoveConfirmation({
  runtime,
  remoteJid,
  userId,
  text,
  send
}) {
  const confirmationReply = detectConfirmationReply(text);
  if (confirmationReply === null) return false;

  const pending = runtime.pendingConfirmations?.findLatest?.(userId);
  if (!pending || pending.type !== "repertoire_remove") return false;

  if (confirmationReply === false) {
    runtime.pendingConfirmations?.resolve?.(userId);
    await send("beleza, não removo então");
    return true;
  }

  const result = removeStickerFromRepertoire({
    basePath: runtime.defaults.stickersPath,
    messageId: pending.payload?.messageId ?? null,
    key: pending.payload?.key ?? null
  });
  runtime.pendingConfirmations?.resolve?.(userId);

  if (!result.ok) {
    const reason =
      result.reason === "builtin"
        ? "essa é figurinha padrão, não dá pra remover"
        : "não achei essa figurinha no repertório pra remover";
    await send(reason);
    return true;
  }

  const label = result.displayName ? `${result.displayName} (${result.key})` : result.key;
  await send(`prontinho, tirei ${label} do repertório`);
  return true;
}

/** Texto do `.help` — só usado no número de comandos de mídia (ou sessão única `full`). */
function formatWhatsAppHelpText(prefix = ".") {
  const p = String(prefix ?? ".");
  const c = (name) => `${p}${name}`;
  return [
    "*Comandos TetOS*",
    "",
    `${c("help")} — Esta lista (também ${p}ajuda).`,
    `${c("sticker")} — Gera figurinha a partir de imagem/vídeo/GIF (também se mandar como documento, formatos aceitos: imagem, GIF, vídeo). Usa a mídia da mensagem, resposta (reply) ou a última mídia recente no chat. Enche o quadrado (stretch). Duração opcional até 30s: ${c("sticker")} 10s, ${c("sticker")} 5000ms.`,
    `${c("fsticker")} — Igual ao anterior, mas mantém tudo visível dentro da figurinha sem cortar (contain). Duração opcional até 30s (ex.: ${c("fsticker")} 8s).`,
    `${c("csticker")} — Recorta o centro para caber na figurinha (crop). Duração opcional até 30s (ex.: ${c("csticker")} 10s).`,
    `${c("optimize")} — Comprime figurinha (reply/anexo); cada uso reduz mais um pouco ate nao dar pra comprimir (também ${p}otimizar).`,
    `${c("removebg")} — Remove fundo de imagem ou figurinha estatica (API remove.bg em media/forte). GIF/video/figurinha animada: so modelo local, sem gastar creditos. Fundo transparente (padrao) ou cor: ${c("removebg")} verde. Potencia: leve, media, forte. Envia como documento (PNG/GIF/MP4).`,
    `${c("toimg")} — Figurinha → imagem ou GIF/vídeo (reply ou anexo à figurinha).`,
    `${c("repertorio")} on|off — Modo repertório: salva automaticamente figurinhas que você mandar/encaminhar.`,
    `${c("repertorio")} remover — Remove figurinha do repertório (marque a figurinha com reply/quote antes).`,
    `${c("tetos")} <mensagem> — Pergunta pontual à IA (sem conversa contínua nem janela de contexto).`
  ].join("\n");
}

function inferDocumentAsMedia(unwrappedMessage = {}) {
  const doc = unwrappedMessage?.documentMessage;
  if (!doc) return null;
  const mime = String(doc?.mimetype ?? "").toLowerCase();
  const name = String(doc?.fileName ?? "").toLowerCase();
  if (/^image\//.test(mime) || /\.(png|jpe?g|webp|gif)$/.test(name)) {
    return { type: "image", doc };
  }
  if (/^video\//.test(mime) || /\.(mp4|webm|mov|m4v|mkv)$/.test(name)) {
    return { type: "video", doc };
  }
  if (/gif/.test(mime) || /\.gif$/.test(name)) {
    return { type: "gif", doc };
  }
  return null;
}

async function attachVisionTranscript(
  runtime,
  { filePath, mediaType, isAnimated = false, userId, remoteJid, skipVision }
) {
  if (skipVision || !filePath) {
    if (mediaType === "sticker") {
      logRepertoireVision(runtime, "ingest_vision_skip", {
        filePath,
        reason: skipVision ? "skipVisionEnrichment" : "no_filePath"
      });
    }
    return null;
  }
  logRepertoireVision(runtime, "ingest_vision_start", {
    filePath,
    mediaType,
    isAnimated,
    userId,
    remoteJid
  });
  const visualDescription = await enrichMediaVision(runtime, {
    filePath,
    mediaType,
    isAnimated
  });
  logRepertoireVision(runtime, "ingest_vision_done", {
    filePath,
    mediaType,
    ok: Boolean(visualDescription),
    preview: visualDescription ? String(visualDescription).slice(0, 120) : null
  });
  if (visualDescription) {
    runtime.visualAnalyses?.save?.({
      userId,
      channelId: remoteJid,
      mediaPath: filePath,
      mediaType,
      description: visualDescription
    });
  }
  return visualDescription;
}

function applyVisionFields(media, visualDescription, { skipVision = false } = {}) {
  if (!media) return media;
  const attempted = !skipVision && Boolean(media.path);
  return {
    ...media,
    transcript: visualDescription ?? media.transcript ?? null,
    visionAttempted: attempted,
    visionStatus: !attempted ? undefined : visualDescription ? "ok" : "failed"
  };
}

/** Propaga descrição visual para índice, memória de grupo e multimodal (mesmo sem resposta do bot). */
function syncIncomingMediaContext(
  runtime,
  {
    remoteJid,
    messageId,
    userId,
    pushName,
    text,
    media,
    stanzaId,
    participantJid,
    chatMessageIndex,
    isGroup
  }
) {
  if (!messageId) return null;
  const displayText = formatMediaInputText({ text, media });
  if (!displayText) return null;

  chatMessageIndex?.append?.({
    channelId: remoteJid,
    messageId,
    actorId: userId,
    speakerName: pushName || null,
    text: displayText,
    isFromBot: false,
    remoteJid,
    quotedMessageId: stanzaId ?? null,
    participantJid: participantJid ?? null
  });

  if (isGroup) {
    runtime.groupMemory?.patchEntry?.(remoteJid, messageId, { text: displayText });
  }

  const visionText = [media?.transcript, media?.caption].filter(Boolean).join(" ").trim();
  if (media?.type && visionText) {
    runtime.multimodalMemory?.save?.({
      userId,
      channelId: remoteJid,
      media,
      message: visionText,
      messageId
    });
  }

  return displayText;
}

function extractParticipantJid(incoming) {
  const participant =
    incoming?.key?.participant ??
    incoming?.participant ??
    "";
  return jidNormalizedUser(participant);
}

function extractParticipantPhone(incoming) {
  const pn =
    incoming?.key?.participantPn ??
    incoming?.participantPn ??
    "";
  if (!pn) return "";
  return extractPhone(jidNormalizedUser(pn));
}

/** JID do remetente em grupo (LID ou tel); legado — preferir extractParticipantJid. */
function extractParticipant(incoming) {
  const phone = extractParticipantPhone(incoming);
  if (phone) return `${phone}@s.whatsapp.net`;
  return extractParticipantJid(incoming);
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function createConversationOrchestrator(
  socket,
  runtime,
  {
    chatMessageIndex = null,
    botJid = "",
    botPhone = "",
    logPrefix = "[whatsapp]",
    mediaHistoryStore = null,
    mediaCommandService = null,
    getWaMessageById = null
  } = {}
) {
  const timingCfg = resolveTimingConfig(runtime?.defaults ?? {});
  const pendingBySession = new Map();
  const pendingByGroupChannel = new Map();
  const queueBySession = new Map();
  const queueByGroupChannel = new Map();
  const runningBySession = new Set();
  const runningByGroupChannel = new Set();
  const deferredBySession = new Map();
  const typingByUser = new Map();
  const interruptBySession = new Map();
  /** Incrementado ao desativar grupo — invalida turnos enfileirados/em voo. */
  const groupChannelEpoch = new Map();
  const currentSessionByGroupChannel = new Map();
  /** @type {Map<string, { messagesSinceLastReaction: number, lastReactionAt: number }>} */
  const reactionStateByUser = new Map();

  function buildSanitizeMeta(item = {}) {
    return {
      messageKey: item.messageKey,
      messageId: item.messageKey?.id ?? item.messageId ?? null,
      message: item.message ?? "",
      quotedMessageId: item.quotedMessageId ?? null,
      quotedMessage: item.quotedMessage ?? null,
      replyThreadContext: item.replyThreadContext ?? null,
      isReply: item.isReply,
      isReplyToBot: item.isReplyToBot,
      isGroup: item.isGroup,
      isDirectMention: item.isDirectMention,
      groupPriorityAddress: item.groupPriorityAddress,
      groupEngagementActive: item.groupEngagementActive,
      closeDecision: item.closeDecision,
      media: item.media,
      batchedCount: item.batchedCount,
      recentHistory: chatMessageIndex?.getThread?.(item.remoteJid, 5) ?? []
    };
  }

  function mergeDirectEntries(previous, entry) {
    if (!previous || !entry) return entry ? { ...entry, batchedCount: entry.batchedCount ?? 1 } : null;
    const differentQuote =
      entry.isReply &&
      previous.quotedMessageId &&
      entry.quotedMessageId &&
      previous.quotedMessageId !== entry.quotedMessageId;
    if (differentQuote) return null;
    const canMergeQuotes =
      !entry.isReply ||
      !previous.isReply ||
      !entry.quotedMessageId ||
      !previous.quotedMessageId ||
      entry.quotedMessageId === previous.quotedMessageId;
    if (!canMergeQuotes) return null;
    return {
      ...entry,
      message: `${previous.message}\n${entry.message}`.trim(),
      messageKey: entry.messageKey ?? previous.messageKey,
      media: entry.media ?? previous.media,
      quotedMessage: entry.quotedMessage ?? previous.quotedMessage,
      quotedMessageId: entry.quotedMessageId ?? previous.quotedMessageId,
      replyThreadContext: entry.replyThreadContext ?? previous.replyThreadContext,
      isReply: entry.isReply || previous.isReply,
      isReplyToBot: entry.isReplyToBot || previous.isReplyToBot,
      isDirectMention: entry.isDirectMention || previous.isDirectMention,
      groupEngagementActive: entry.groupEngagementActive || previous.groupEngagementActive,
      groupPriorityAddress: entry.groupPriorityAddress || previous.groupPriorityAddress,
      groupAddressKind: entry.groupAddressKind ?? previous.groupAddressKind,
      pushName: entry.pushName ?? previous.pushName,
      isOwner: entry.isOwner || previous.isOwner,
      sleepDisturbedWake: entry.sleepDisturbedWake || previous.sleepDisturbedWake,
      sleepTemporarilyAwake: entry.sleepTemporarilyAwake || previous.sleepTemporarilyAwake,
      tempWakeGrogginess: Math.max(
        entry.tempWakeGrogginess ?? 0,
        previous.tempWakeGrogginess ?? 0
      ),
      tempWakeExtensionCount: Math.max(
        entry.tempWakeExtensionCount ?? 0,
        previous.tempWakeExtensionCount ?? 0
      ),
      sleepGroggy: entry.sleepGroggy || previous.sleepGroggy,
      batchedCount: (previous.batchedCount ?? 1) + (entry.batchedCount ?? 1)
    };
  }

  function flushDeferredSession(sessionId) {
    const deferred = deferredBySession.get(sessionId);
    if (!deferred) return;
    deferredBySession.delete(sessionId);
    if (deferred.batchedCount > 1) {
      console.log(`[whatsapp] deferred batch ${deferred.batchedCount} msgs → 1 reply (${sessionId})`);
    }
    enqueue(deferred);
  }

  function buildVerifiedQuoteKey(remoteJid, quoteId, {
    participantJid = null,
    participantId = null,
    hintText = null
  } = {}) {
    if (!quoteId) return null;
    const resolved = resolveVerifiedQuoteKey({
      channelId: remoteJid,
      remoteJid,
      quoteId,
      chatMessageIndex,
      getWaMessageById,
      groupMemory: runtime.groupMemory,
      participantJid,
      participantId,
      hintText
    });
    if (!resolved.quoteKey) {
      if (resolved.reason === "not_found" && resolved.requestedId) {
        console.warn(
          `${logPrefix} quote id inexistente (${resolved.requestedId}) — enviando sem reply`
        );
      }
      return null;
    }
    if (resolved.resolvedFrom && resolved.resolvedFrom !== resolved.messageId) {
      console.log(
        `${logPrefix} quote ${resolved.resolvedFrom} → ${resolved.messageId} (${resolved.reason})`
      );
    }
    return resolved.quoteKey;
  }

  function resolveQuotedWaMessage(quoteKey, remoteJid) {
    const id = quoteKey?.id;
    if (!id) return null;
    const stored = getWaMessageById?.(id);
    if (stored?.key?.id && stored?.message) return stored;
    const indexed = chatMessageIndex?.get(remoteJid, id);
    if (!indexed) return null;
    const text = String(indexed.text ?? "").trim();
    const key = {
      remoteJid: quoteKey.remoteJid ?? remoteJid,
      id,
      fromMe: Boolean(indexed.isFromBot)
    };
    if (indexed.participantJid) key.participant = indexed.participantJid;
    if (/^\[image\]/i.test(text)) {
      return { key, message: { imageMessage: { caption: text.replace(/^\[image\]\s*/i, "") } } };
    }
    if (/^\[sticker\]/i.test(text)) {
      return { key, message: { stickerMessage: {} } };
    }
    return {
      key,
      message: text ? { conversation: text } : { extendedTextMessage: { text: "…" } }
    };
  }

  function resolveActionQuoteKey(quoteId, item, { hintText = null } = {}) {
    if (!quoteId) return null;
    const resolved = resolveVerifiedQuoteKey({
      channelId: item.remoteJid,
      remoteJid: item.remoteJid,
      quoteId,
      chatMessageIndex,
      getWaMessageById,
      groupMemory: runtime.groupMemory,
      participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
      participantId: item.participantId ?? null,
      hintText
    });
    if (!resolved.quoteKey && resolved.reason === "not_found") {
      console.warn(
        `${logPrefix} quote inválido (${resolved.requestedId}) — enviando sem reply`
      );
    } else if (resolved.resolvedFrom && resolved.resolvedFrom !== resolved.messageId) {
      console.log(
        `${logPrefix} quote corrigido ${resolved.resolvedFrom} → ${resolved.messageId} (${resolved.reason})`
      );
    }
    return resolved.quoteKey;
  }

  async function sendReplies(remoteJid, userId, sessionId, replies = [], token = 0, options = {}) {
    const quoteKey = options?.quoteMessageKey ?? null;
    if (options?.allowReply === false || !runtime.defaults.replyEnabled) return;
    const plan = options?.timingPlan ?? {};
    try {
      for (let index = 0; index < replies.length; index += 1) {
        const content = String(replies[index] ?? "").trim();
        if (!content) continue;
        if (interruptBySession.get(sessionId) !== token) {
          console.warn(
            `${logPrefix} send interrompido bolha ${index + 1}/${replies.length} (interrupt token mismatch)`
          );
          return;
        }
        const remotePhone = extractPhone(remoteJid);
        const len = content.length;
        const isGroup = remoteJid.endsWith("@g.us");
        let needsTyping;
        let typingDelayMs;
        if (isGroup) {
          needsTyping = false;
          typingDelayMs = plan.readDelayMs ? Math.min(plan.readDelayMs, 1200) : 0;
          if (typingDelayMs > 0) await sleep(typingDelayMs);
          typingDelayMs = 0;
        } else if (index > 0) {
          needsTyping = true;
          typingDelayMs = estimateTypingFromCfg(content, index, timingCfg);
        } else if (len <= 4) {
          needsTyping = false;
          typingDelayMs = 0;
        } else {
          needsTyping = true;
          const base = index === 0 && plan.typingDelayMs
            ? plan.typingDelayMs
            : estimateTypingFromCfg(content, index, timingCfg);
          const extraDelay = options?.softened ? randBetween(120, 320) : 0;
          typingDelayMs = Math.min(
            timingCfg.typingMaxDelayMs,
            Math.max(timingCfg.firstBubbleTypingFloorMs, base + extraDelay)
          );
        }
        if (index === 0 && needsTyping && typingDelayMs > 0) {
          await sleep(randBetween(timingCfg.postModelBeforeBubbleMinMs, timingCfg.postModelBeforeBubbleMaxMs));
        }
        if (needsTyping && typingDelayMs > 0 && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("composing", remoteJid);
            await sleep(typingDelayMs);
            await socket.sendPresenceUpdate("paused", remoteJid);
          } catch (error) {
            console.warn(`${logPrefix} typing simulation failed for ${remotePhone}: ${error.message}`);
          }
        }
        if (interruptBySession.get(sessionId) !== token) {
          console.warn(
            `${logPrefix} send interrompido bolha ${index + 1}/${replies.length} após typing (interrupt token mismatch)`
          );
          return;
        }
        const perBubbleQuotes = Array.isArray(options?.quoteMessageKeys) ? options.quoteMessageKeys : [];
        const rawQuote =
          perBubbleQuotes[index] ??
          (index === 0 ? quoteKey : null);
        let normalizedQuote = null;
        if (rawQuote?.id) {
          normalizedQuote = buildVerifiedQuoteKey(remoteJid, rawQuote.id, {
            participantJid: options?.participantJid ?? rawQuote.participant ?? null,
            participantId: options?.participantId ?? null
          });
        }
        if (index === 0 && normalizedQuote?.id) {
          console.log(`${logPrefix} outgoing quote id=${normalizedQuote.id} → ${remoteJid}`);
        }
        console.log(`${logPrefix} outgoing ${remoteJid}: ${content}`);
        let rosterMembers = options?.groupRoster?.members ?? [];
        if (isGroup && !rosterMembers.length) {
          rosterMembers = buildGroupRoster(runtime, remoteJid).members ?? [];
        }
        const { text: mentionText, mentions } = translateAtMentions(content, rosterMembers);
        const mentionPayload = mentions.length ? { mentions } : {};
        const indexedRow =
          normalizedQuote?.id && chatMessageIndex
            ? chatMessageIndex.get(remoteJid, normalizedQuote.id)
            : null;
        const quotedWa = resolveQuotedWaMessage(normalizedQuote, remoteJid);
        let payload = { text: mentionText, ...mentionPayload };
        if (!quotedWa && normalizedQuote?.id && indexedRow) {
          payload = applyQuotedContextToPayload(payload, normalizedQuote, indexedRow);
        }
        const sendTask = quotedWa
          ? socket.sendMessage(remoteJid, payload, { quoted: quotedWa })
          : socket.sendMessage(remoteJid, payload);
        const sent = await Promise.race([
          sendTask,
          new Promise((_, reject) => setTimeout(() => reject(new Error("send timeout")), 8000))
        ]).catch((error) => {
          console.error(`${logPrefix} send failed to ${remoteJid}:`, error.message);
          return null;
        });
        const sentId = sent?.key?.id ?? sent?.message?.key?.id ?? null;
        if (sentId && chatMessageIndex) {
          chatMessageIndex.append({
            channelId: remoteJid,
            messageId: sentId,
            actorId: "teto",
            text: content,
            isFromBot: true,
            remoteJid,
            quotedMessageId: normalizedQuote?.id ?? null,
            participantJid: socket?.user?.id ? jidNormalizedUser(socket.user.id) : null,
            tetosOneShot: Boolean(options?.tetosCommand)
          });
        }
        if (index < replies.length - 1) {
          const planned = options?.bubbleDelays?.[index + 1];
          const interPartDelayMs =
            Number.isFinite(planned) && planned > 0
              ? planned
              : randBetween(timingCfg.multiPartDelayMinMs, timingCfg.multiPartDelayMaxMs);
          await sleep(interPartDelayMs);
        }
      }
    } finally {
      if (typeof socket.sendPresenceUpdate === "function") {
        try {
          await socket.sendPresenceUpdate("paused", remoteJid);
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function processQueueItem(item) {
    const allowReply = runtime.defaults.replyEnabled && !item.mainObserveOnly;
    const sessionId = item.sessionId ?? item.userId;
    const groupEpoch =
      item.isGroup && item.remoteJid ? (groupChannelEpoch.get(item.remoteJid) ?? 0) : null;
    const activation = runtime.tetoActivation;
    const typingUntil = typingByUser.get(item.userId) ?? 0;
        let outputKind = RESPONSE_OUTPUTS.SILENT;
        addDecisionStep(item.decisionTrace, "queue.processing", {
          allowReply,
          closeDecision: item.closeDecision ?? null
        });
        const abortGroupTurn = (reason) => {
          addDecisionStep(item.decisionTrace, "queue.aborted", { reason });
          finalizeDecisionTrace(runtime, item.decisionTrace, {
            activation: "group_blocked",
            output: RESPONSE_OUTPUTS.IGNORED
          });
        };
        if (shouldDropGroupQueueItem(item, groupEpoch, activation)) {
          abortGroupTurn("group_deactivated");
          return;
        }
        if (item.isGroup && item.remoteJid) {
          currentSessionByGroupChannel.set(item.remoteJid, sessionId);
        }
        const token = Date.now();
        interruptBySession.set(sessionId, token);
        const prevR = reactionStateByUser.get(item.userId) ?? {
          messagesSinceLastReaction: 10,
          lastReactionAt: 0
        };
        const reactionState = {
          messagesSinceLastReaction: (prevR.messagesSinceLastReaction ?? 0) + 1,
          lastReactionAt: prevR.lastReactionAt ?? 0
        };
        let replies = [];
        const shouldGenerate =
          item.closeDecision !== "silent" && item.closeDecision !== "react";
        let composingDuringGeneration = false;
        try {
        let timingPlan = null;
        const shouldRunPipeline =
          runtime.defaults.replyEnabled ||
          runtime.defaults.learningModeEnabled ||
          item.mainObserveOnly;
        if (shouldRunPipeline) {
          if (shouldGenerate) {
            console.log(`${logPrefix} generating reply for ${item.userId}…`);
          }
          let lastError = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const genStart = Date.now();
              const out = await Promise.race([
                withGenerationSlot(() =>
                  handleIncomingMessage(runtime, {
                    message: item.message,
                    userId: item.userId,
                    sessionId: item.sessionId,
                    channelId: item.channelId,
                    isGroup: item.isGroup,
                    participants: item.participants,
                    isDirectMention: item.isDirectMention,
                    groupEngagementActive: item.groupEngagementActive ?? false,
                    groupAddressKind: item.groupAddressKind ?? null,
                    isReply: item.isReply,
                    isReplyToBot: item.isReplyToBot ?? false,
                    quotedMessage: item.quotedMessage,
                    quotedMessageId: item.quotedMessageId ?? null,
                    replyThreadContext: item.replyThreadContext ?? null,
                    messageKey: item.messageKey,
                    closeDecision: item.closeDecision,
                    media: item.media,
                    pushName: item.pushName ?? null,
                    participantId: item.participantId ?? null,
                    segmentSpeakers: item.segmentSpeakers ?? null,
                    segmentMultiSpeaker: item.segmentMultiSpeaker ?? false,
                    groupCatchUp: item.groupCatchUp === true,
                    groupCatchUpSkipped: item.groupCatchUpSkipped ?? 0,
                    sleepCatchUp: item.sleepCatchUp === true,
                    sleepCatchUpCount: item.sleepCatchUpCount ?? 0,
                    sleepDisturbedWake: item.sleepDisturbedWake === true,
                    sleepTemporarilyAwake: item.sleepTemporarilyAwake === true,
                    tempWakeGrogginess: item.tempWakeGrogginess ?? 0,
                    tempWakeExtensionCount: item.tempWakeExtensionCount ?? 0,
                    sleepGroggy: item.sleepGroggy === true,
                    batchedCount: item.batchedCount ?? 1,
                    isOwner: item.isOwner ?? false,
                    mainObserveOnly: item.mainObserveOnly === true,
                    tetosCommand: item.tetosCommand === true,
                    onGenerationStart: async () => {
                      if (typeof socket.sendPresenceUpdate !== "function") return;
                      composingDuringGeneration = true;
                      await socket.sendPresenceUpdate("composing", item.remoteJid);
                    }
                  })
                ),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("model timeout")), timingCfg.modelTimeoutMs)
                )
              ]);

              replies = out?.replies ?? [];
              item.groupRoster = out?.groupRoster ?? null;
              if (replies.length > 0) {
                console.log(
                  `${logPrefix} reply ${replies.length} bolha(s) → ${replies.map((r) => JSON.stringify(String(r ?? "").slice(0, 140))).join(" | ")}`
                );
              }
              timingPlan = out?.timingPlan ?? null;
              const targetLatency = (timingPlan?.readDelayMs ?? 0) + (timingPlan?.thinkDelayMs ?? 0);
              let remaining = Math.max(0, targetLatency - (Date.now() - genStart));
              if (item.groupCatchUp && remaining > 0) {
                remaining = Math.min(remaining, item.isGroup ? 500 : 800);
              }
              if (item.sleepCatchUp && remaining > 0) {
                remaining = Math.min(remaining, 600);
              }
              if (item.isGroup && (queueByGroupChannel.get(item.remoteJid)?.length ?? 0) > 0) {
                remaining = Math.min(remaining, 350);
              }
              if (remaining > 0 && replies.length > 0) {
                await sleep(remaining);
              }
              if (shouldDropGroupQueueItem(item, groupEpoch, activation)) {
                abortGroupTurn("group_deactivated_post_gen");
                return;
              }
              item.passiveMode = out?.policy?.mode ?? RESPONSE_MODES.FULL;
              addDecisionStep(item.decisionTrace, "pipeline.completed", {
                mode: item.passiveMode,
                replyCount: replies.length
              });
              if (item.passiveMode === RESPONSE_MODES.REACT_ONLY) {
                const reactActions = Array.isArray(replies.actions)
                  ? replies.actions.filter((a) => a.type === "react")
                  : [];
                if (reactActions.length) {
                  replies = [];
                  replies.actions = reactActions;
                } else {
                  replies = [];
                }
              }
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              if (error.message === "model timeout" && attempt === 0) {
                console.warn(`${logPrefix} model timeout, retrying for ${item.userId}…`);
                await sleep(400);
                continue;
              }
              if (/empty response/i.test(error.message) && attempt === 0) {
                console.warn(`${logPrefix} LLM resposta vazia, retrying for ${item.userId}…`);
                await sleep(600);
                continue;
              }
              console.error(`${logPrefix} generation error for ${item.userId}:`, error.message);
              replies = [];
              break;
            }
          }
          if (lastError?.message === "model timeout") {
            runtime.logger?.log?.("whatsapp.model_timeout", { userId: item.userId, sessionId: item.sessionId });
          }
          if ((!replies || replies.length === 0) && lastError) {
            console.error(`${logPrefix} critical failure in generation, triggering fallback error...\n`);
            try {
              const fallbackRaw = await runtime.agent.respond(
                item.message,
                {
                  userId: item.userId,
                  sessionId: item.sessionId,
                  fallback: "error",
                  errorMsg: lastError.message,
                  skipUserRecord: true
                },
                null,
                "calm"
              );
              if (fallbackRaw && !/^\[SEM_RESPOSTA\]/i.test(String(fallbackRaw).trim())) {
                replies = [fallbackRaw.trim()];
                replies.actions = [{ type: "message", text: replies[0], quoteId: null }];
              }
            } catch (fallbackError) {
              console.error(`${logPrefix} fallback LLM query failed:`, fallbackError.message);
            }

            if (!replies || replies.length === 0) {
              const fallbackText = `Alguem fala pra gabbis to com o probleminha "${lastError.message || "ERRO"}"`;
              replies = [fallbackText];
              replies.actions = [{ type: "message", text: fallbackText, quoteId: null }];
            }
          }
        } else {
          replies = [];
          item.passiveMode = RESPONSE_MODES.LEARN_ONLY;
          logThinking(runtime, {
            phase: "observe_only",
            userId: item.userId,
            remoteJid: item.remoteJid,
            detail: `closeDecision=${item.closeDecision} media=${item.media?.type ?? "none"}`
          });
          runtime.logger?.log?.("learning.observe_only_skipped", {
            userId: item.userId,
            channelId: item.channelId
          });
        }

        const hasOutgoing =
          Array.isArray(replies) && replies.some((r) => String(r ?? "").trim().length > 0);
        if (!hasOutgoing && shouldRunPipeline && allowReply) {
          console.warn(
            `${logPrefix} empty reply for ${item.userId} (close=${item.closeDecision} mode=${item.passiveMode ?? "?"} msg="${String(item.message ?? "").slice(0, 80)}")`
          );
        }
        if (hasOutgoing && !composingDuringGeneration && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("composing", item.remoteJid);
          } catch (e) {
            console.warn(`${logPrefix} composing (before send) failed: ${e.message}`);
          }
        }

        runtime.timeStore?.markSeen(item.userId, Date.now(), item.sessionId);
        runtime.userPatterns?.recordInteraction(item.userId);
        if (!hasOutgoing && typeof socket.sendPresenceUpdate === "function") {
          try {
            await socket.sendPresenceUpdate("paused", item.remoteJid);
          } catch (_) {
            /* ignore */
          }
        }
        if (interruptBySession.get(sessionId) !== token) {
          finalizeDecisionTrace(runtime, item.decisionTrace, {
            activation: "allowed",
            pipelineMode: item.passiveMode ?? RESPONSE_MODES.FULL,
            output: RESPONSE_OUTPUTS.IGNORED
          });
          return;
        }
        if (shouldDropGroupQueueItem(item, groupEpoch, activation)) {
          abortGroupTurn("group_deactivated_pre_send");
          return;
        }
        let executedActions = false;
        let reactedThisTurn = false;
        let autoQuotedThisTurn = false;
        if (replies && Array.isArray(replies.actions) && replies.actions.length > 0 && allowReply) {
          executedActions = true;
          const softened = runtime.userPatterns
            ? !runtime.userPatterns.isLikelyActiveNow(item.userId)
            : false;
          const actionsToRun = resolveOutgoingActions(
            sanitizeOutgoingActions(replies.actions, buildSanitizeMeta(item))
          );
          const mediaActions = actionsToRun.filter(
            (a) =>
              a.type === "media" ||
              a.type === "toimage" ||
              a.type === "url_download" ||
              a.type === "generate_image"
          );
          const immediateActions = sortImmediateActions(
            actionsToRun.filter(
              (a) =>
                a.type !== "media" &&
                a.type !== "toimage" &&
                a.type !== "url_download" &&
                a.type !== "generate_image"
            )
          );
          console.log(
            `${logPrefix} action plan (${actionsToRun.length}): ${actionsToRun
              .map((a) => `${a.type}${a.command ? `:${a.command}` : ""}${a.key ? `:${a.key}` : ""}`)
              .join(", ")}`
          );
          const runAction = async (action, index) => {
            if (interruptBySession.get(sessionId) !== token) {
              console.warn(`${logPrefix} execution interrupted (token mismatch)`);
              return false;
            }
            if (index > 0) {
              await sleep(randBetween(800, 1500));
            }
            try {
              if (action.type === "react") {
                const reactionKey = buildOutgoingQuoteKey(item.messageKey, item.remoteJid, {
                  participantId: item.participantId ?? null,
                  participantJid: item.participantJid ?? item.messageKey?.participant ?? null
                });
                if (reactionKey && action.emoji) {
                  console.log(`${logPrefix} executing action reaction: ${action.emoji}`);
                  await socket.sendMessage(item.remoteJid, {
                    react: { text: action.emoji, key: reactionKey }
                  });
                  outputKind = RESPONSE_OUTPUTS.REACTION;
                  reactedThisTurn = true;
                }
              } else if (action.type === "sticker") {
                const stickerAsset = resolveStickerAsset(action.key, runtime.defaults.stickersPath);
                if (stickerAsset) {
                  console.log(`${logPrefix} executing action sticker: ${action.key}`);
                  const quote = resolveActionQuoteKey(action.quoteId, item);
                  const indexedRow =
                    quote?.id && chatMessageIndex
                      ? chatMessageIndex.get(item.remoteJid, quote.id)
                      : null;
                  const quotedWa = resolveQuotedWaMessage(quote, item.remoteJid);
                  const payload = quotedWa
                    ? { sticker: stickerAsset }
                    : applyQuotedContextToPayload({ sticker: stickerAsset }, quote, indexedRow);
                  await socket.sendMessage(
                    item.remoteJid,
                    payload,
                    quotedWa ? { quoted: quotedWa } : undefined
                  );
                  outputKind = RESPONSE_OUTPUTS.STICKER;
                  runtime.metrics?.increment?.("whatsapp.sticker.sent");
                }
              } else if (action.type === "save_sticker") {
                const targetId =
                  chatMessageIndex?.resolveQuoteMessageId?.(item.remoteJid, action.messageId) ??
                  action.messageId;
                const resolved = await resolveMediaByMessageId({
                  messageId: targetId,
                  chatId: item.remoteJid,
                  mediaHistoryStore,
                  basePath: runtime.defaults.whatsappMediaPath,
                  visualAnalyses: runtime.visualAnalyses,
                  getWaMessageById,
                  triggerMessageId: item.messageKey?.id ?? null,
                  downloadContentFromMessage
                });
                if (resolved?.media?.type !== "sticker" || !resolved.media.path) {
                  await sendReplies(
                    item.remoteJid,
                    item.userId,
                    item.sessionId,
                    ["so consigo salvar figurinha — manda o message id de uma sticker"],
                    token,
                    { allowReply, groupRoster: item.groupRoster ?? null }
                  );
                  outputKind = RESPONSE_OUTPUTS.TEXT;
                } else {
                  const userKeyProvided = Boolean(String(action.key ?? "").trim());
                  const saved = await saveStickerToRepertoireWithVision({
                    runtime,
                    sourcePath: resolved.media.path,
                    basePath: runtime.defaults.stickersPath,
                    key: action.key,
                    messageId: targetId,
                    savedFrom: item.remoteJid,
                    label: action.label,
                    media: resolved.media,
                    userId: item.userId,
                    remoteJid: item.remoteJid,
                    skipVision: userKeyProvided
                  });
                  if (!runtime.repertoireHandledMessageIds) {
                    runtime.repertoireHandledMessageIds = new Map();
                  }
                  runtime.repertoireHandledMessageIds.set(targetId, Date.now());
                  logRepertoireVision(runtime, "manual_save_ok", {
                    key: saved.key,
                    messageId: targetId,
                    displayName: saved.displayName ?? null,
                    visionSource: saved.visionSource ?? null,
                    autoNamed: saved.autoNamed ?? false,
                    hadMediaTranscript: Boolean(resolved.media?.transcript)
                  });
                  console.log(
                    `${logPrefix} saved sticker to repertoire: ${saved.key} (${saved.path})${saved.displayName ? ` — ${saved.displayName}` : ""}`
                  );
                  runtime.logger?.log?.("whatsapp.sticker_repertoire_saved", {
                    key: saved.key,
                    messageId: targetId,
                    remoteJid: item.remoteJid,
                    displayName: saved.displayName ?? null,
                    autoNamed: saved.autoNamed ?? false
                  });
                  const saveLabel = saved.displayName
                    ? `${saved.displayName} (${saved.key})`
                    : saved.key;
                  const quoteKeyForSave = buildQuoteKeyFromMessageId(
                    chatMessageIndex,
                    item.remoteJid,
                    targetId,
                    {
                      participantId: item.participantId ?? null,
                      participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                      getWaMessageById,
                      groupMemory: runtime.groupMemory
                    }
                  );
                  await sendReplies(
                    item.remoteJid,
                    item.userId,
                    item.sessionId,
                    [`salvei no repertório como ${saveLabel} kkk`],
                    token,
                    {
                      allowReply,
                      groupRoster: item.groupRoster ?? null,
                      participantId: item.participantId ?? null,
                      participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                      quoteMessageKey: quoteKeyForSave
                    }
                  );
                  outputKind = RESPONSE_OUTPUTS.COMMAND;
                }
              } else if (action.type === "repertoire_mode") {
                const store = runtime.stickerRepertoireMode;
                if (store) {
                  if (action.enabled) {
                    store.enable(item.userId, {
                      channelId: item.remoteJid,
                      enabledBy: item.userId
                    });
                    console.log(`${logPrefix} repertoire mode ON for ${item.userId}`);
                  } else {
                    store.disable(item.userId);
                    console.log(`${logPrefix} repertoire mode OFF for ${item.userId}`);
                  }
                }
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "silence") {
                const eng = runtime.groupEngagement;
                if (eng?.muteFromAgent) {
                  const applied = eng.muteFromAgent(item.remoteJid, item.userId, {
                    scope: action.scope,
                    ttlMs: runtime.defaults.groupMuteMs
                  });
                  console.log(
                    `${logPrefix} calar scope=${applied?.scope ?? "channel"} until=${applied?.expiresAt ?? "?"}`
                  );
                }
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "url_download") {
                console.log(
                  `${logPrefix} executing url_download ${action.command}: ${action.url}`
                );
                const urlRun = mediaCommandService.runUrlDownloadCommand({
                  command: action.command,
                  url: action.url,
                  args: action.args ?? [],
                  remoteJid: item.remoteJid,
                  userId: item.userId
                });
                urlRun.catch((err) => {
                  console.error(
                    `${logPrefix} url download failed (${action.command}):`,
                    err?.message ?? err
                  );
                });
                void urlRun;
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "media" || action.type === "toimage") {
                const command = action.command ?? "toimg";
                const targetId =
                  chatMessageIndex?.resolveQuoteMessageId?.(item.remoteJid, action.messageId) ??
                  action.messageId;
                const resolved = await resolveMediaByMessageId({
                  messageId: targetId,
                  chatId: item.remoteJid,
                  mediaHistoryStore,
                  basePath: runtime.defaults.whatsappMediaPath,
                  visualAnalyses: runtime.visualAnalyses,
                  getWaMessageById,
                  triggerMessageId: item.messageKey?.id ?? null,
                  downloadContentFromMessage
                });
                // #region agent log
                fetch('http://127.0.0.1:7284/ingest/e819ca91-0aba-4afa-8c2a-d066631af9d0',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'928ed5'},body:JSON.stringify({sessionId:'928ed5',runId:'post-fix',location:'messageHandler.js:mediaAction',message:'agent media action execute',data:{command,actionMessageId:action.messageId,targetId,resolvedSource:resolved?.source??null,hasMediaPath:Boolean(resolved?.media?.path),mediaType:resolved?.media?.type??null,itemQuotedId:item.quotedMessageId??null,triggerMessageId:item.messageKey?.id??null},timestamp:Date.now(),hypothesisId:'E'})}).catch(()=>{});
                // #endregion
                console.log(
                  `${logPrefix} executing action ${command}: ${targetId} (source=${resolved?.source ?? "none"})`
                );
                const mediaRun = mediaCommandService.runAgentMediaCommand({
                  command,
                  messageId: targetId,
                  args: action.args ?? [],
                  media: resolved?.media ?? null,
                  remoteJid: item.remoteJid,
                  userId: item.userId,
                  targetSource: resolved?.source ?? "agent"
                });
                mediaRun.catch((err) => {
                  console.error(`${logPrefix} agent media command failed (${command}):`, err?.message ?? err);
                });
                void mediaRun;
                outputKind = RESPONSE_OUTPUTS.COMMAND;
              } else if (action.type === "generate_image") {
                const result = await runtime.imageGenerationService?.generate?.({
                  prompt: action.prompt,
                  userId: item.userId
                });
                if (result?.ok && result.buffer) {
                  await safeSendMessage(item.remoteJid, { image: result.buffer });
                  if (action.caption) {
                    await sendReplies(
                      item.remoteJid,
                      item.userId,
                      item.sessionId,
                      [action.caption],
                      token,
                      { softened, timingPlan, allowReply, groupRoster: item.groupRoster ?? null }
                    );
                  }
                  outputKind = RESPONSE_OUTPUTS.COMMAND;
                } else if (result?.error) {
                  await sendReplies(
                    item.remoteJid,
                    item.userId,
                    item.sessionId,
                    [`não consegui gerar a imagem: ${result.error}`],
                    token,
                    { softened, timingPlan, allowReply, groupRoster: item.groupRoster ?? null }
                  );
                }
              } else if (action.type === "message") {
                console.log(`${logPrefix} executing action message: ${action.text} (quoteId: ${action.quoteId})`);
                const explicitQuote = action.quoteId ?? null;
                const autoQuoteId =
                  explicitQuote ??
                  (autoQuotedThisTurn ? null : resolveOutgoingQuoteId(item));
                if (!explicitQuote && autoQuoteId) {
                  autoQuotedThisTurn = true;
                }
                const quoteKey = resolveActionQuoteKey(autoQuoteId, item);
                await sendReplies(item.remoteJid, item.userId, item.sessionId, [action.text], token, {
                  softened,
                  timingPlan,
                  allowReply,
                  groupRoster: item.groupRoster ?? null,
                  participantId: item.participantId ?? null,
                  participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                  quoteMessageKey: quoteKey
                });
                outputKind = RESPONSE_OUTPUTS.TEXT;
              }
            } catch (actionError) {
              console.error(`${logPrefix} failed to execute action ${action.type}:`, actionError.message);
            }
            return true;
          };
          for (let index = 0; index < immediateActions.length; index += 1) {
            const done = await runAction(immediateActions[index], index);
            if (done === false) break;
          }
          for (let index = 0; index < mediaActions.length; index += 1) {
            const done = await runAction(
              mediaActions[index],
              immediateActions.length > 0 ? index + 1 : index
            );
            if (done === false) break;
          }
        }

        const tryPassiveReaction = async () => {
          if (!allowReply || reactedThisTurn) return false;
          const passiveAction = resolvePassiveModeAction({
            policy: { allowed: true, mode: item.passiveMode },
            media: item.media,
            isGroup: item.isGroup
          });
          const affinities =
            runtime.brainOrchestrator?.mediaHub?.getAffinities?.({
              userId: item.userId,
              channelId: item.channelId ?? item.remoteJid,
              isGroup: item.isGroup
            }) ?? null;
          const plan = planWhatsAppReaction({
            userText: item.message,
            state: reactionState,
            affinities
          });
          const forcedReaction =
            item.closeDecision === "react" || passiveAction.type === RESPONSE_MODES.REACT_ONLY
              ? "❤️"
              : null;
          const emoji = plan.emoji ?? forcedReaction;
          const reactionKey = buildOutgoingQuoteKey(item.messageKey, item.remoteJid, {
            participantId: item.participantId ?? null,
            participantJid: item.participantJid ?? item.messageKey?.participant ?? null
          });
          if (!emoji || !reactionKey || typeof socket.sendMessage !== "function") {
            reactionStateByUser.set(item.userId, {
              messagesSinceLastReaction: reactionState.messagesSinceLastReaction,
              lastReactionAt: reactionState.lastReactionAt
            });
            return false;
          }
          try {
            await socket.sendMessage(item.remoteJid, {
              react: { text: emoji, key: reactionKey }
            });
            outputKind = RESPONSE_OUTPUTS.REACTION;
            reactedThisTurn = true;
            reactionStateByUser.set(item.userId, {
              messagesSinceLastReaction: 0,
              lastReactionAt: Date.now()
            });
            return true;
          } catch (e) {
            console.warn(`[whatsapp] reaction failed: ${e.message}`);
            reactionStateByUser.set(item.userId, {
              ...reactionState,
              lastReactionAt: reactionState.lastReactionAt
            });
            return false;
          }
        };

        if (executedActions) {
          await tryPassiveReaction();
        }

        if (!executedActions) {
        const passiveAction = resolvePassiveModeAction({
          policy: { allowed: true, mode: item.passiveMode },
          media: item.media,
          isGroup: item.isGroup
        });

        const affinities =
          runtime.brainOrchestrator?.mediaHub?.getAffinities?.({
            userId: item.userId,
            channelId: item.channelId ?? item.remoteJid,
            isGroup: item.isGroup
          }) ?? null;
        const plan = planWhatsAppReaction({
          userText: item.message,
          state: reactionState,
          affinities
        });
        const forcedReaction = item.closeDecision === "react" || passiveAction.type === RESPONSE_MODES.REACT_ONLY ? "❤️" : null;
        const emoji = plan.emoji ?? forcedReaction;
        const reactionKey = buildOutgoingQuoteKey(item.messageKey, item.remoteJid, {
          participantId: item.participantId ?? null,
          participantJid: item.participantJid ?? item.messageKey?.participant ?? null
        });
        const reacted = Boolean(emoji && reactionKey && typeof socket.sendMessage === "function");
        if (reacted && allowReply) {
          try {
            await socket.sendMessage(item.remoteJid, {
              react: { text: emoji, key: reactionKey }
            });
            outputKind = RESPONSE_OUTPUTS.REACTION;
            reactionStateByUser.set(item.userId, {
              messagesSinceLastReaction: 0,
              lastReactionAt: Date.now()
            });
          } catch (e) {
            console.warn(`[whatsapp] reaction failed: ${e.message}`);
            reactionStateByUser.set(item.userId, {
              ...reactionState,
              lastReactionAt: reactionState.lastReactionAt
            });
          }
        } else {
          reactionStateByUser.set(item.userId, {
            messagesSinceLastReaction: reactionState.messagesSinceLastReaction,
            lastReactionAt: reactionState.lastReactionAt
          });
        }
        const softened = runtime.userPatterns
          ? !runtime.userPatterns.isLikelyActiveNow(item.userId)
          : false;
        if (!reacted && passiveAction.type === RESPONSE_MODES.STICKER_ONLY && allowReply) {
          const stickerAsset = resolveStickerAsset(passiveAction.stickerKey, runtime.defaults.stickersPath);
          if (stickerAsset) {
            try {
              await socket.sendMessage(item.remoteJid, { sticker: stickerAsset });
              outputKind = RESPONSE_OUTPUTS.STICKER;
              runtime.metrics?.increment?.("whatsapp.sticker.sent");
              runtime.logger?.log?.("whatsapp.sticker_sent", {
                remoteJid: item.remoteJid,
                stickerKey: stickerAsset.key
              });
            } catch (error) {
              runtime.logger?.log?.("whatsapp.sticker_error", {
                remoteJid: item.remoteJid,
                error: error.message
              });
            }
          } else {
            runtime.metrics?.increment?.("whatsapp.sticker.missing_asset");
            runtime.logger?.log?.("whatsapp.sticker_missing_asset", {
              remoteJid: item.remoteJid,
              stickerKey: passiveAction.stickerKey
            });
          }
        }

        if (!reacted && allowReply) {
          const hasOutgoing =
            Array.isArray(replies) && replies.some((r) => String(r ?? "").trim().length > 0);
          if (hasOutgoing) {
            let waitForTypingMs = Math.max(0, typingUntil - Date.now());
            if (waitForTypingMs > 0) {
              if (Math.random() < 0.14) {
                waitForTypingMs = Math.min(waitForTypingMs, randBetween(120, 420));
              } else if (Math.random() < 0.09) {
                waitForTypingMs = Math.floor(waitForTypingMs * 0.32);
              }
              await sleep(waitForTypingMs);
            }
            const debounceMs = randBetween(timingCfg.interruptDebounceMinMs, timingCfg.interruptDebounceMaxMs);
            await sleep(debounceMs);
          }
          const quoteTargetId = item.tetosCommand ? null : resolveOutgoingQuoteId(item);
          const quoteKeyForSend =
            !item.tetosCommand && quoteTargetId
              ? buildQuoteKeyFromMessageId(chatMessageIndex, item.remoteJid, quoteTargetId, {
                  participantId: item.participantId ?? null,
                  participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
                  getWaMessageById,
                  groupMemory: runtime.groupMemory
                })
              : null;
          const shouldQuote = Boolean(quoteKeyForSend);
          const quoteKeys = Array.isArray(item.quoteMessageKeys)
            ? item.quoteMessageKeys
            : shouldQuote
              ? replies.map((_, i) => (i === 0 ? quoteKeyForSend : item.quoteMessageKeys?.[i] ?? null))
              : [];
          const bubbleProcessor = runtime.chatService?.getProcessor?.({ sessionId: item.sessionId });
          const bubbleDelays = bubbleProcessor?.lastBubblePlan?.delays ?? null;
          await sendReplies(item.remoteJid, item.userId, item.sessionId, replies, token, {
            softened,
            timingPlan,
            bubbleDelays,
            allowReply,
            groupRoster: item.groupRoster ?? null,
            participantId: item.participantId ?? null,
            participantJid: item.participantJid ?? item.messageKey?.participant ?? null,
            quoteMessageKey: shouldQuote ? quoteKeyForSend : null,
            quoteMessageKeys: quoteKeys.filter(Boolean).length ? quoteKeys : undefined,
            tetosCommand: item.tetosCommand === true
          });
          if (hasOutgoing) {
            outputKind = RESPONSE_OUTPUTS.TEXT;
          }
        }
        }
        finalizeDecisionTrace(runtime, item.decisionTrace, {
          activation: "allowed",
          pipelineMode: item.passiveMode ?? RESPONSE_MODES.FULL,
          output: outputKind
        });
        } finally {
          if (
            item.isGroup &&
            item.remoteJid &&
            currentSessionByGroupChannel.get(item.remoteJid) === sessionId
          ) {
            currentSessionByGroupChannel.delete(item.remoteJid);
          }
          if (composingDuringGeneration && typeof socket.sendPresenceUpdate === "function") {
            try {
              await socket.sendPresenceUpdate("paused", item.remoteJid);
            } catch (_) {
              /* ignore */
            }
          }
        }
  }

  async function drainSessionQueue(sessionId) {
    if (runningBySession.has(sessionId)) return;
    runningBySession.add(sessionId);
    try {
      while (queueBySession.get(sessionId)?.length) {
        const item = queueBySession.get(sessionId).shift();
        if (!item) continue;
        await processQueueItem(item);
      }
    } finally {
      runningBySession.delete(sessionId);
      flushDeferredSession(sessionId);
    }
  }

  async function drainGroupChannel(channelKey) {
    if (runningByGroupChannel.has(channelKey)) return;
    runningByGroupChannel.add(channelKey);
    try {
      while (queueByGroupChannel.get(channelKey)?.length) {
        const item = queueByGroupChannel.get(channelKey).shift();
        if (!item) continue;
        await processQueueItem(item);
        if (queueByGroupChannel.get(channelKey)?.length) {
          await sleep(randBetween(timingCfg.interruptDebounceMinMs, timingCfg.interruptDebounceMaxMs + 500));
        }
      }
    } finally {
      runningByGroupChannel.delete(channelKey);
    }
  }

  function enqueueGroupSegment(entry) {
    const channelKey = entry.remoteJid;
    const priority = isGroupPriorityEntry(entry);
    if (runningByGroupChannel.has(channelKey) && priority) {
      bumpInterrupt(entry.sessionId ?? entry.userId);
    }
    let queue = queueByGroupChannel.get(channelKey) ?? [];
    if (priority) {
      queue.unshift(entry);
    } else {
      queue.push(entry);
    }
    const before = queue.length;
    queue = compactGroupQueueSegments(queue);
    if (queue.length < before) {
      console.log(
        `[whatsapp] fila grupo compactada ${before}→${queue.length} (${channelKey})`
      );
    }
    queueByGroupChannel.set(channelKey, queue);
    drainGroupChannel(channelKey).catch((error) => {
      console.error("[whatsapp] group channel queue error:", error.message);
    });
  }

  function processCollectedGroupEntries(channelKey, collected = []) {
    if (!collected.length) return;
    const floodPlan = planFloodAwareGroupSegments(collected);
    const segments = floodPlan.segments;
    if (floodPlan.mode === "catchup" && floodPlan.droppedCount > 0) {
      console.log(
        `[whatsapp] grupo rajada: ${collected.length} msgs — absorveu ${floodPlan.droppedCount}, responde só ao recente (${channelKey})`
      );
    }
    segments.sort(
      (a, b) => Number(Boolean(b.groupPriorityAddress)) - Number(Boolean(a.groupPriorityAddress))
    );
    if (segments.length > 1) {
      console.log(
        `[whatsapp] grupo ${collected.length} msgs → ${segments.length} resposta(s) com quote (${channelKey})`
      );
    } else if ((segments[0]?.batchedCount ?? 1) > 1) {
      console.log(
        `[whatsapp] grupo batch ${segments[0].batchedCount} msgs → 1 resposta (${channelKey})`
      );
    }
    for (const seg of segments) {
      enqueueGroupSegment(seg);
    }
  }

  function scheduleGroupIncoming(entry) {
    const channelKey = entry.remoteJid;
    const priority = isGroupPriorityEntry(entry);
    const normalized = { ...entry, ts: entry.ts ?? Date.now(), groupPriorityAddress: priority };

    let pending = pendingByGroupChannel.get(channelKey) ?? { entries: [], timer: null };

    if (pending.timer) clearTimeout(pending.timer);

    if (priority && pending.entries.some((e) => !isGroupPriorityEntry(e))) {
      const nonPriority = pending.entries.filter((e) => !isGroupPriorityEntry(e));
      const keepPriority = pending.entries.filter((e) => isGroupPriorityEntry(e));
      if (nonPriority.length) {
        processCollectedGroupEntries(channelKey, nonPriority);
      }
      pending.entries = keepPriority;
    }

    pending.entries.push(normalized);

    const stillTyping = pending.entries.some(
      (e) => (typingByUser.get(e.userId) ?? 0) > Date.now()
    );
    const hasPriority = pending.entries.some(isGroupPriorityEntry);
    const baseBatch = hasPriority
      ? Math.min(450, timingCfg.groupBatchWindowMs)
      : timingCfg.groupBatchWindowMs;
    const batchMs = stillTyping
      ? Math.min(hasPriority ? 2800 : 6500, Math.round(baseBatch * (hasPriority ? 1.6 : 2.4)))
      : baseBatch;

    pending.timer = setTimeout(() => {
      const collected = pending.entries;
      pendingByGroupChannel.delete(channelKey);
      processCollectedGroupEntries(channelKey, collected);
    }, batchMs);

    pendingByGroupChannel.set(channelKey, pending);
  }

  function coalesceQueueEntries(entries = []) {
    if (entries.length <= 1) return entries;
    const first = entries[0];
    const merged = entries.slice(1).reduce(
      (acc, cur) => ({
        ...acc,
        message: `${acc.message}\n${cur.message}`.trim(),
        messageKey: cur.messageKey ?? acc.messageKey,
        media: cur.media ?? acc.media,
        quotedMessage: cur.quotedMessage ?? acc.quotedMessage,
        quotedMessageId: cur.quotedMessageId ?? acc.quotedMessageId,
        replyThreadContext: cur.replyThreadContext ?? acc.replyThreadContext,
        isReply: cur.isReply || acc.isReply,
        isReplyToBot: cur.isReplyToBot || acc.isReplyToBot,
        isDirectMention: cur.isDirectMention || acc.isDirectMention,
        groupEngagementActive: cur.groupEngagementActive || acc.groupEngagementActive,
        groupPriorityAddress: cur.groupPriorityAddress || acc.groupPriorityAddress,
        groupAddressKind: cur.groupAddressKind ?? acc.groupAddressKind,
        batchedCount: (acc.batchedCount ?? 1) + (cur.batchedCount ?? 1),
        pushName: cur.pushName ?? acc.pushName
      }),
      { ...first, batchedCount: first.batchedCount ?? 1 }
    );
    return [merged];
  }

  function enqueue(entry) {
    const key = entry.sessionId ?? entry.userId;
    let queue = queueBySession.get(key) ?? [];
    const maxCoalesce = Number(runtime.defaults.maxQueueCoalesce ?? 6);

    if (runningBySession.has(key) && shouldBumpInterruptOnEnqueue(entry)) {
      bumpInterrupt(key);
    }

    const last = queue[queue.length - 1];
    const mergedWithLast = last ? mergeDirectEntries(last, entry) : null;
    if (mergedWithLast && queue.length < maxCoalesce) {
      queue[queue.length - 1] = mergedWithLast;
    } else if (queue.length >= maxCoalesce - 1) {
      queue = coalesceQueueEntries([...queue, entry]);
      console.warn(`[whatsapp] fila ${key} cheia — ${maxCoalesce} msgs fundidas em 1 resposta`);
    } else {
      queue.push(entry);
    }

    queueBySession.set(key, queue);
    drainSessionQueue(key).catch((error) => {
      console.error("[whatsapp] queue processing error:", error.message);
    });
  }

  function scheduleDirectIncoming(entry) {
    const key = entry.sessionId ?? entry.userId;

    if (runningBySession.has(key)) {
      const prev = deferredBySession.get(key);
      const merged = prev ? mergeDirectEntries(prev, entry) : { ...entry, batchedCount: entry.batchedCount ?? 1 };
      if (merged) {
        deferredBySession.set(key, merged);
      } else {
        deferredBySession.set(key, { ...entry, batchedCount: entry.batchedCount ?? 1 });
      }
      return;
    }

    let previous = pendingBySession.get(key);

    const differentQuote =
      entry.isReply &&
      previous &&
      previous.quotedMessageId &&
      entry.quotedMessageId &&
      previous.quotedMessageId !== entry.quotedMessageId;

    // Reply explícito (quote) → não mistura quotes diferentes; flush o pendente
    if (entry.isReply && previous?.timer) {
      clearTimeout(previous.timer);
      const flushed = { ...previous };
      delete flushed.timer;
      pendingBySession.delete(key);
      enqueue(flushed);
      previous = null;
    } else if (differentQuote && previous?.timer) {
      clearTimeout(previous.timer);
      const flushed = { ...previous };
      delete flushed.timer;
      pendingBySession.delete(key);
      enqueue(flushed);
      previous = null;
    }

    if (previous?.timer) clearTimeout(previous.timer);
    const canMergeQuotes =
      !entry.isReply ||
      !previous?.isReply ||
      !entry.quotedMessageId ||
      !previous.quotedMessageId ||
      entry.quotedMessageId === previous.quotedMessageId;

    const merged = previous && canMergeQuotes
      ? mergeDirectEntries(previous, entry) ?? { ...entry, batchedCount: entry.batchedCount ?? 1 }
      : { ...entry, batchedCount: entry.batchedCount ?? 1 };

    const typingUntil = typingByUser.get(entry.userId) ?? 0;
    const stillTyping = typingUntil > Date.now();
    const baseBatch = entry.isGroup ? timingCfg.groupBatchWindowMs : timingCfg.batchWindowMs;
    const batchMs = stillTyping
      ? Math.min(5500, Math.round(baseBatch * 2.2))
      : Math.min(4500, Math.round(baseBatch * 1.35));

    const timer = setTimeout(() => {
      pendingBySession.delete(key);
      if (merged.batchedCount > 1) {
        console.log(`[whatsapp] batch ${merged.batchedCount} msgs → 1 reply (${key})`);
      }
      enqueue(merged);
    }, batchMs);
    pendingBySession.set(key, { ...merged, timer });
  }

  function scheduleIncoming(entry) {
    const withDefaults = {
      preferQuoteReply: false,
      ts: Date.now(),
      ...entry
    };
    if (withDefaults.isGroup) {
      scheduleGroupIncoming(withDefaults);
      return;
    }
    scheduleDirectIncoming(withDefaults);
  }

  function onPresenceUpdate(update = {}) {
    const id = jidNormalizedUser(update?.id ?? "");
    const userId = extractPhone(id);
    if (!userId) return;
    const presences = update?.presences ?? {};
    const userPresence = presences[id] ?? presences[`${userId}@s.whatsapp.net`] ?? null;
    const isTyping = userPresence?.lastKnownPresence === "composing";
    if (isTyping) {
      typingByUser.set(userId, Date.now() + timingCfg.typingGraceMs);
    }
  }


  /** Invalidate in-flight replies when user sends a new message (must stay inside closure). */
  function bumpInterrupt(sessionId) {
    interruptBySession.set(sessionId, Date.now());
  }

  function shouldDropGroupQueueItem(item, groupEpoch, activation) {
    if (!item?.isGroup || !item.remoteJid) return false;
    if (item.tetosCommand) return false;
    const channelKey = item.remoteJid;
    if ((groupChannelEpoch.get(channelKey) ?? 0) !== groupEpoch) return true;
    if (activation && !activation.isGroupActive(channelKey)) return true;
    return false;
  }

  function abortGroupChannel(channelKey) {
    const id = String(channelKey ?? "").trim();
    if (!id) return { clearedPending: 0, clearedQueue: 0, interruptedSessions: 0 };

    groupChannelEpoch.set(id, (groupChannelEpoch.get(id) ?? 0) + 1);

    const sessions = new Set();
    const pending = pendingByGroupChannel.get(id);
    if (pending?.timer) clearTimeout(pending.timer);
    for (const entry of pending?.entries ?? []) {
      const sid = entry.sessionId ?? entry.userId;
      if (sid) sessions.add(sid);
    }
    const clearedPending = pending?.entries?.length ?? 0;
    pendingByGroupChannel.delete(id);

    const queue = queueByGroupChannel.get(id) ?? [];
    for (const item of queue) {
      const sid = item.sessionId ?? item.userId;
      if (sid) sessions.add(sid);
    }
    const clearedQueue = queue.length;
    queueByGroupChannel.delete(id);

    const active = currentSessionByGroupChannel.get(id);
    if (active) sessions.add(active);

    for (const sid of sessions) bumpInterrupt(sid);

    if (clearedPending || clearedQueue || sessions.size) {
      console.log(
        `[whatsapp] grupo abortado: pendente=${clearedPending} fila=${clearedQueue} sessoes=${sessions.size} (${id})`
      );
    }

    return {
      clearedPending,
      clearedQueue,
      interruptedSessions: sessions.size
    };
  }

  function shouldBumpInterruptOnEnqueue(entry = {}) {
    const text = String(entry.message ?? "").trim();
    if (!text) return false;
    if (/^\[(sticker|image|video|gif|audio|figurinha)\]/i.test(text)) return false;
    return true;
  }

  const IMMEDIATE_ACTION_PRIORITY = {
    react: 1,
    message: 2,
    sticker: 3,
    silence: 4,
    repertoire_mode: 5,
    url_download: 6,
    media: 7,
    toimage: 7,
    generate_image: 7,
    save_sticker: 9
  };

  function sortImmediateActions(actions = []) {
    return [...actions].sort(
      (a, b) =>
        (IMMEDIATE_ACTION_PRIORITY[a.type] ?? 5) - (IMMEDIATE_ACTION_PRIORITY[b.type] ?? 5)
    );
  }

  /** Já recebemos o texto — não esperar grace de "composing" do turno anterior (evita +atraso antes do modelo). */
  function clearTypingGrace(userId) {
    typingByUser.delete(userId);
  }

  return {
    scheduleIncoming,
    onPresenceUpdate,
    bumpInterrupt,
    clearTypingGrace,
    abortGroupChannel
  };
}

export function registerMessageHandler({ socket, runtime, role = "full" }) {
  if (socket.__tetosHandlerRegistered) return;
  socket.__tetosHandlerRegistered = true;

  const mainObserveOnly =
    role === "main" &&
    runtime.defaults.whatsappMode === "dual" &&
    runtime.defaults.whatsappMainObserveOnly;
  const botChatRole =
    role === "media" && runtime.defaults.whatsappMode === "dual" && runtime.defaults.whatsappMainObserveOnly;
  const waLogPrefix =
    role === "media" ? "[whatsapp:media]" : role === "main" ? "[whatsapp:main]" : "[whatsapp]";
  const chatMessageIndex =
    runtime.chatMessageIndex ?? new ChatMessageIndex({ maxPerChannel: 80 });
  if (!runtime.chatMessageIndex) {
    runtime.chatMessageIndex = chatMessageIndex;
  }
  const botJidForHandler = jidNormalizedUser(socket?.user?.id ?? socket?.user?.jid ?? "");
  const botPhoneForHandler = extractPhone(botJidForHandler);
  const messageSnapshotById = new Map();
  const waMessageById = new Map();
  const commandQueue = new ChatCommandQueue();
  const mediaHistoryStore = new ChatMediaHistoryStore(runtime.defaults.commandMediaHistoryLimit);
  const mediaProcessor = new MediaProcessor({
    outputDir: runtime.defaults.commandMediaDerivedPath,
    maxStickerBytes: runtime.defaults.tetosStickerMaxBytes,
    removeBgApiKeys: runtime.defaults.removeBgApiKeys,
    removeBgModel: runtime.defaults.removeBgModel
  });
  const mediaCommandService = new MediaCommandService({
    runtime,
    socket,
    commandQueue,
    mediaHistoryStore,
    mediaProcessor,
    safeSendMessage,
    chatMessageIndex,
    logPrefix: waLogPrefix
  });
  const orchestrator =
    role === "media" && !botChatRole
      ? null
      : createConversationOrchestrator(socket, runtime, {
          chatMessageIndex,
          botJid: botJidForHandler,
          botPhone: botPhoneForHandler,
          logPrefix: waLogPrefix,
          mediaHistoryStore,
          mediaCommandService,
          getWaMessageById: (id) => waMessageById.get(id) ?? null
        });
  const seenMessageIds = new Map();
  const ownerRedirectDedupe = new Map();
  const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
  const processedCommandDeduper = createProcessedCommandDeduper();
  const skipVisionEnrichment = role === "media" && !botChatRole;
  const sleepDisturbanceFloodBySession = new Map();

  function trackSleepDisturbanceFlood(sessionId, text) {
    const key = String(sessionId ?? "default");
    const now = Date.now();
    const windowMs = sleepDisturbanceFloodWindowMs();
    let row = sleepDisturbanceFloodBySession.get(key);
    if (!row || now - row.startedAt > windowMs) {
      row = { startedAt: now, count: 0 };
    }
    row.count += 1;
    sleepDisturbanceFloodBySession.set(key, row);
    return row;
  }

  function clearSleepDisturbanceFlood(sessionId) {
    sleepDisturbanceFloodBySession.delete(String(sessionId ?? "default"));
  }

  function scheduleWithSleepCatchUp(entry) {
    if (!orchestrator) return;
    const buffered = runtime.sleepMessageBuffer?.flush?.(entry.sessionId);
    if (buffered) {
      const mergedMessage = entry.message
        ? `${buffered.message}\n---\n${entry.message}`.trim()
        : buffered.message;
      orchestrator.scheduleIncoming({
        ...entry,
        message: mergedMessage,
        batchedCount:
          (buffered.sleepCatchUpCount ?? buffered.batchedCount ?? 1) + (entry.batchedCount ?? 1),
        sleepCatchUp: true,
        sleepCatchUpCount:
          (buffered.sleepCatchUpCount ?? buffered.batchedCount ?? 1) + (entry.batchedCount ?? 1),
        messageKey: entry.messageKey ?? buffered.messageKey,
        quotedMessageId: entry.quotedMessageId ?? buffered.quotedMessageId ?? null,
        isReply: entry.isReply || buffered.isReply
      });
      return;
    }
    orchestrator.scheduleIncoming(entry);
  }

  console.log(
    `${waLogPrefix} handler ativo${
      botChatRole
        ? " (responde chat)"
        : mainObserveOnly
          ? " (aprende — sem responder)"
          : role === "main"
            ? " (principal)"
            : ""
    }`
  );
  if (orchestrator) {
    socket.ev.on("presence.update", orchestrator.onPresenceUpdate);
  }

  function isWaConnectionError(error) {
    const msg = String(error?.message ?? error ?? "");
    return (
      /connection closed/i.test(msg) ||
      error?.output?.statusCode === 428 ||
      error?.output?.payload?.statusCode === 428
    );
  }

  async function safeSendMessage(jid, payload) {
    try {
      return await socket.sendMessage(jid, payload);
    } catch (error) {
      if (isWaConnectionError(error)) {
        console.warn(`${waLogPrefix} envio abortado (conexao fechada) → ${jid}`);
        return null;
      }
      throw error;
    }
  }

  async function handleMediaCommand({
    incoming,
    parsedCommand,
    remoteJid,
    userId,
    media
  }) {
    return commandQueue.enqueue(remoteJid, async () => {
      const startedAt = Date.now();
      const resolved = await resolveCommandTarget({
        incoming,
        remoteJid,
        userId,
        media,
        historyStore: mediaHistoryStore,
        persistMedia,
        downloadContentFromMessage,
        basePath: runtime.defaults.whatsappMediaPath
      });
      if (!resolved?.media?.path) {
        await safeSendMessage(remoteJid, {
          text: "Nao achei midia valida. Manda a imagem/GIF no anexo, responde (reply) a uma midia, ou manda a midia e depois o comando."
        });
        runtime.eventLedger?.append?.({
          eventType: "command.media",
          commandName: parsedCommand.command,
          status: "error",
          reason: "target_not_found",
          remoteJid,
          actorId: userId
        });
        return true;
      }

      if (parsedCommand.command === "removebg") {
        const bgOptsEarly = resolveRemoveBgOptions(parsedCommand.args);
        if (!bgOptsEarly.error) {
          const potencyKey = bgOptsEarly.model ?? runtime.defaults.removeBgModel ?? "small";
          const potencyLabel = REMOVE_BG_MODEL_LABELS[potencyKey] ?? potencyKey;
          const animTarget = await isAnimatedRemoveBgTarget(resolved.media);
          const statusText = animTarget
            ? `Removendo fundo animado (modelo local — nao gasta creditos remove.bg)... pode demorar bastante.`
            : `Removendo fundo (${potencyLabel})...`;
          try {
            await socket.sendPresenceUpdate?.("composing", remoteJid);
          } catch {
            /* opcional */
          }
          await safeSendMessage(remoteJid, { text: statusText });
          try {
            await socket.sendPresenceUpdate?.("paused", remoteJid);
          } catch {
            /* opcional */
          }
        }
      }

      try {
        let output = null;
        const stickerCommands = ["sticker", "fsticker", "csticker"];
        if (stickerCommands.includes(parsedCommand.command)) {
          const durationResolved = resolveStickerDurationArg(parsedCommand.args?.[0]);
          if (durationResolved.error) {
            await safeSendMessage(remoteJid, { text: durationResolved.error });
            return true;
          }
          try {
            await socket.sendPresenceUpdate?.("composing", remoteJid);
          } catch {
            /* opcional */
          }
          const mode =
            parsedCommand.command === "fsticker"
              ? "contain"
              : parsedCommand.command === "csticker"
                ? "crop"
                : "stretch";
          output = await mediaProcessor.toSticker(resolved.media, mode, {
            maxDurationMs: durationResolved.maxDurationMs
          });
          try {
            await socket.sendPresenceUpdate?.("paused", remoteJid);
          } catch {
            /* opcional */
          }
        } else if (parsedCommand.command === "optimize") {
          if (resolved.media.type !== "sticker") {
            await safeSendMessage(remoteJid, {
              text: "O .optimize so funciona com figurinhas. Marque uma figurinha (reply ou anexo) e tente de novo."
            });
            return true;
          }
          try {
            await socket.sendPresenceUpdate?.("composing", remoteJid);
          } catch {
            /* opcional */
          }
          output = await mediaProcessor.optimizeSticker(resolved.media);
          try {
            await socket.sendPresenceUpdate?.("paused", remoteJid);
          } catch {
            /* opcional */
          }
          if (output.alreadyOptimized) {
            const kb = Math.round((output.sizeBytes ?? 0) / 1024);
            await safeSendMessage(remoteJid, {
              text: `Nao deu pra comprimir mais esta figurinha (${kb} KiB).`
            });
            return true;
          }
        } else if (parsedCommand.command === "removebg") {
          const bgOpts = resolveRemoveBgOptions(parsedCommand.args);
          if (bgOpts.error) {
            await safeSendMessage(remoteJid, { text: bgOpts.error });
            return true;
          }
          output = await mediaProcessor.removeBackground(resolved.media, {
            background: bgOpts.background,
            model: bgOpts.model
          });
        } else if (parsedCommand.command === "toimg") {
          output = await mediaProcessor.toMediaFromSticker(resolved.media);
        }

        const skipToimgPlayback =
          parsedCommand.command === "toimg" &&
          output.kind === "video" &&
          output.toimgPlaybackSkipped === true;
        if (!output?.path && !skipToimgPlayback) throw new Error("processing failed");

        const outBuffer = output.path ? readFileSync(output.path) : null;

        if (parsedCommand.command === "removebg") {
          const sent = await safeSendMessage(remoteJid, {
            document: outBuffer,
            mimetype: output.mimetype ?? "image/png",
            fileName: output.fileName ?? "sem-fundo.png"
          });
          if (!sent) return true;
          const elapsedMs = Date.now() - startedAt;
          runtime.eventLedger?.append?.({
            eventType: "command.media",
            commandName: parsedCommand.command,
            status: "ok",
            targetSource: resolved.source,
            inputType: resolved.media.type,
            outputType: output.kind,
            remoteJid,
            actorId: userId,
            elapsedMs
          });
          return true;
        }

        if (parsedCommand.command === "toimg") {
          if (output.kind === "video") {
            const gifPath = output.toimgGifPath;
            const gifBuffer = gifPath && existsSync(gifPath) ? readFileSync(gifPath) : null;
            const gifDocMeta = {
              mimetype: "image/gif",
              fileName: "sticker-convertido.gif"
            };

            if (outBuffer) {
              const playbackMime = output.toimgPlaybackMime ?? "video/mp4";
              await safeSendMessage(
                remoteJid,
                buildWaGifPlaybackPayload(outBuffer, {
                  mimetype: playbackMime,
                  seconds: output.toimgPlaybackSeconds
                })
              );
              if (gifBuffer) {
                await safeSendMessage(remoteJid, buildWaDocumentPayload(gifBuffer, gifDocMeta));
              }
            } else if (gifBuffer) {
              await safeSendMessage(
                remoteJid,
                buildWaGifPlaybackPayload(gifBuffer, { mimetype: "image/gif" })
              );
              await safeSendMessage(remoteJid, buildWaDocumentPayload(gifBuffer, gifDocMeta));
            }
          } else {
            await safeSendMessage(remoteJid, { image: outBuffer });
            await safeSendMessage(
              remoteJid,
              buildWaDocumentPayload(outBuffer, {
                mimetype: "image/png",
                fileName: "sticker-convertido.png"
              })
            );
          }
        } else if (output.kind === "video") {

          await safeSendMessage(remoteJid, { sticker: outBuffer });

        } else {

          await safeSendMessage(remoteJid, { sticker: outBuffer });

        }

        if (
          parsedCommand.command === "optimize" &&
          output.previousSizeBytes &&
          output.sizeBytes &&
          output.sizeBytes < output.previousSizeBytes
        ) {
          const beforeKb = Math.round(output.previousSizeBytes / 1024);
          const afterKb = Math.round(output.sizeBytes / 1024);
          await safeSendMessage(remoteJid, {
            text: `Figurinha otimizada: ${beforeKb} KiB → ${afterKb} KiB. Pode mandar .optimize de novo pra comprimir mais.`
          });
        }

        const elapsedMs = Date.now() - startedAt;
        if (runtime.defaults.thinkingLogsEnabled) {
          console.log(`[audit.command] ${JSON.stringify({
            ts: new Date().toISOString(),
            commandName: parsedCommand.command,
            status: "ok",
            targetSource: resolved.source,
            inputType: resolved.media.type,
            outputType: output.kind,
            remoteJid,
            actorId: userId,
            elapsedMs
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "command.media",
          commandName: parsedCommand.command,
          status: "ok",
          targetSource: resolved.source,
          inputType: resolved.media.type,
          outputType: output.kind,
          remoteJid,
          actorId: userId,
          elapsedMs
        });
        return true;
      } catch (error) {
        if (isWaConnectionError(error)) {
          console.warn(
            `${waLogPrefix} comando ${parsedCommand.command} interrompido — conexao caiu (${remoteJid})`
          );
          return true;
        }
        const failText =
          parsedCommand.command === "removebg"
            ? resolved.media?.type === "sticker"
              ? "Nao consegui remover o fundo dessa figurinha. Estatica: reply + .removebg forte. Animada e instavel — tenta uma figurinha estatica."
              : "Nao consegui remover o fundo desta midia. Imagem/figurinha estatica: .removebg forte. GIF/video animado costuma falhar no modelo local."
            : `Falha ao processar ${parsedCommand.command}: ${error.message}`;
        await safeSendMessage(remoteJid, { text: failText });
        runtime.eventLedger?.append?.({
          eventType: "command.media",
          commandName: parsedCommand.command,
          status: "error",
          reason: error.message,
          targetSource: resolved.source,
          inputType: resolved.media?.type ?? null,
          remoteJid,
          actorId: userId
        });
        if (runtime.defaults.thinkingLogsEnabled) {
          console.log(`[audit.command] ${JSON.stringify({
            ts: new Date().toISOString(),
            commandName: parsedCommand.command,
            status: "error",
            reason: error.message,
            targetSource: resolved.source,
            remoteJid,
            actorId: userId
          })}`);
        }
        return true;
      }
    });
  }

  async function maybeRedirectOwnerToBotDm({ remoteJid, userId, text, isFromMe, isGroup }) {
    if (!mainObserveOnly || isFromMe || isGroup) return false;
    if (!isOwnerContact(runtime, remoteJid, userId)) return false;

    const botPhone = String(runtime.whatsappBotPhoneE164 ?? "").trim();
    if (!botPhone) return false;

    const wantsChat =
      hasVocativeToTeto(text) ||
      /\b(acorda|acordar|oi|ol[aá]|hey|e\s*a[ií])\b/i.test(String(text ?? ""));
    if (!wantsChat) return false;

    const dedupeKey = `${userId}:bot-redirect`;
    const lastAt = ownerRedirectDedupe.get(dedupeKey) ?? 0;
    if (Date.now() - lastAt < 45 * 60 * 1000) return false;
    ownerRedirectDedupe.set(dedupeKey, Date.now());

    await safeSendMessage(remoteJid, {
      text:
        `Neste número eu só aprendo (sessão da dona). Para eu responder no chat, manda mensagem para +${botPhone} — número da Teto.`
    });
    logThinking(runtime, {
      phase: "dual_redirect",
      userId,
      remoteJid,
      detail: `redirecionou dona para +${botPhone}`
    });
    return true;
  }

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    const batch = messages ?? [];
    const inboundSource =
      botChatRole || role === "full" ? "bot" : role === "main" ? "main" : "media";
    touchInboundActivity(inboundSource);
    console.log(`${waLogPrefix} upsert type=${type ?? "?"} count=${batch.length}`);

    if (type !== "notify" && type !== "append") {
      if (runtime.defaults.thinkingLogsEnabled && batch.length > 0) {
        console.warn(`${waLogPrefix} upsert ignorado (type=${type}) — msg nao processada`);
      }
      return;
    }

    for (const incoming of batch) {
      try {
        const rawIncomingMessage = incoming?.message ?? {};
        const viewOnceStubOnly = !incoming?.message && isViewOnceStub(incoming);
        if (!incoming?.message && !viewOnceStubOnly) continue;
        if (incoming?.messageStubType && !incoming.message?.conversation && !isViewOnceStub(incoming)) {
          continue;
        }
        const protocolMessage = rawIncomingMessage?.protocolMessage;
        if (protocolMessage?.key) {
          const deletedId = protocolMessage.key?.id ?? null;
          const deletedRemoteJid = protocolMessage.key?.remoteJid ?? incoming.key?.remoteJid ?? null;
          const previous = deletedId ? messageSnapshotById.get(deletedId) : null;
          const reason = protocolMessage?.type === 0 ? "revoke" : "protocol";
          if (runtime?.defaults?.thinkingLogsEnabled) {
            console.log(`[audit.delete] ${JSON.stringify({
              ts: new Date().toISOString(),
              messageId: deletedId,
              remoteJid: deletedRemoteJid,
              before: previous?.text ?? null,
              reason
            })}`);
          }
          runtime.eventLedger?.append?.({
            eventType: "message.deleted",
            messageId: deletedId,
            remoteJid: deletedRemoteJid,
            beforeText: previous?.text ?? null,
            beforeMediaType: previous?.mediaType ?? null,
            reason
          });
          if (deletedId) {
            messageSnapshotById.delete(deletedId);
          }
          continue;
        }
        if (rawIncomingMessage?.protocolMessage || rawIncomingMessage?.senderKeyDistributionMessage) {
          continue;
        }

        if (viewOnceStubOnly) {
          const remoteJid = jidNormalizedUser(incoming.key?.remoteJid ?? "");
          if (!remoteJid || remoteJid.endsWith("@broadcast") || incoming.key?.fromMe) continue;
          const isGroup = remoteJid.endsWith("@g.us");
          const baseUserId = extractPhone(remoteJid);
          const participantPhone = isGroup ? extractParticipantPhone(incoming) : "";
          let participantId = isGroup
            ? extractLocalPart(extractParticipantJid(incoming)) || participantPhone
            : "";
          const userId = isGroup
            ? participantId || baseUserId
            : canonicalUserId(runtime, baseUserId, { remoteJid });
          void runtime.viewOnceMirror
            ?.mirrorIncoming?.({
              incoming,
              rawMessage: {},
              role,
              remoteJid,
              userId,
              pushName: incoming.pushName ?? null,
              isGroup,
              receiveSocket: socket
            })
            ?.catch?.((err) => {
              console.warn(`${waLogPrefix} viewonce mirror (stub):`, err?.message ?? err);
            });
          continue;
        }

        const messageKeyId = incoming.key?.id ?? "";
        if (messageKeyId) {
          const lastSeenAt = seenMessageIds.get(messageKeyId);
          if (lastSeenAt && Date.now() - lastSeenAt < MESSAGE_DEDUPE_TTL_MS) {
            continue;
          }
          seenMessageIds.set(messageKeyId, Date.now());
        }

        const remoteJidRaw = incoming.key?.remoteJid ?? "";
        const remoteJid = jidNormalizedUser(remoteJidRaw);
        if (!remoteJid || remoteJid.endsWith("@broadcast") || remoteJid === "status@broadcast") {
          continue;
        }

        const isGroup = remoteJid.endsWith("@g.us");
        const unwrappedMessage = unwrapMessage(rawIncomingMessage);
        let text = extractText(unwrappedMessage).trim();
        const links = extractLinks(text);
        const parsedCommand = parseMediaCommand(text, runtime.defaults.commandPrefix);
        const commandPrefix = runtime.defaults.commandPrefix;
        const tetoSlash = parseTetoSlashCommand(text, commandPrefix);
        const tetosCmd = parseTetosCommand(text, commandPrefix);
        const mediaKind = detectMediaKind(unwrappedMessage);
        const botJid = botJidForHandler || jidNormalizedUser(socket?.user?.id ?? socket?.user?.jid ?? "");
        const participantJid = isGroup ? extractParticipantJid(incoming) : "";
        const isFromMe = Boolean(incoming.key?.fromMe) || 
                         (participantJid && botJid && jidNormalizedUser(participantJid) === jidNormalizedUser(botJid)) ||
                         (!isGroup && remoteJid && botJid && jidNormalizedUser(remoteJid) === jidNormalizedUser(botJid));
        const hasMediaPayload = Boolean(
          unwrappedMessage?.imageMessage ||
          unwrappedMessage?.videoMessage ||
          unwrappedMessage?.audioMessage ||
          unwrappedMessage?.stickerMessage ||
          unwrappedMessage?.documentMessage
        );
        let media = null;
        const isViewOnceInbound =
          isViewOnceMessage(rawIncomingMessage, incoming.key) || isViewOnceStub(incoming);
        if (!text && !hasMediaPayload && !isViewOnceInbound) continue;
        console.log(`${waLogPrefix} ${isFromMe ? "outgoing" : "incoming"} ${remoteJid}: ${text || `[${mediaKind}]`}`);

        const baseUserId = extractPhone(remoteJid);
        const participantPhone = isGroup ? extractParticipantPhone(incoming) : "";
        let participantId = isGroup
          ? extractLocalPart(participantJid) || participantPhone
          : "";
        if (isGroup && !participantId) {
          const msgId = incoming.key?.id ?? "";
          participantId = msgId ? `grp_${String(msgId).slice(-12)}` : `grp_${Date.now()}`;
          console.warn(`[whatsapp] grupo sem participantId em ${remoteJid}; usando ${participantId}`);
        }
        const userId = isGroup
          ? participantId
          : canonicalUserId(runtime, baseUserId, { remoteJid });
        const sessionId = isGroup && participantId
          ? `wa-group:${baseUserId}:${participantId}`
          : canonicalSessionId(runtime, userId, { remoteJid });
        const identitySnapshot = buildWhatsappIdentitySnapshot({
          remoteJid,
          userId,
          participantId: isGroup ? participantId : null,
          sessionId,
          channelId: remoteJid,
          isGroup
        });
        const decisionTrace = createDecisionTrace({
          eventId: messageKeyId || null,
          source: `whatsapp:${role}`,
          userId,
          channelId: remoteJid,
          sessionId,
          isGroup
        });
        decisionTrace.inputType = parsedCommand
          ? "command"
          : hasMediaPayload && text
            ? "mixed"
            : hasMediaPayload
              ? "media"
              : "text";
        decisionTrace.command = tetoSlash?.command ?? parsedCommand?.command ?? (tetosCmd ? "tetos" : null);
        addDecisionStep(decisionTrace, "identity.resolved", identitySnapshot);

        let isTetosCommand = false;
        let tetosMessage = "";

        if (tetosCmd && !isFromMe && (role !== "media" || botChatRole)) {
          if (type === "append") {
            finalizeDecisionTrace(runtime, decisionTrace, {
              tetosCommand: "append_replay",
              output: RESPONSE_OUTPUTS.IGNORED
            });
            continue;
          }
          const tetosContextEarly = extractContextInfo(unwrappedMessage);
          tetosMessage = resolveTetosMessage(tetosCmd, {
            botPhone: botPhoneForHandler || extractPhone(botJid),
            mentionHint: tetosContextEarly?.mentionedJid ?? []
          });
          if (!tetosMessage) {
            await safeSendMessage(remoteJid, { text: formatTetosUsage(commandPrefix) });
            finalizeDecisionTrace(runtime, decisionTrace, {
              tetosCommand: true,
              output: RESPONSE_OUTPUTS.COMMAND
            });
            continue;
          }
          isTetosCommand = true;
        }

        const viewUnicaCmd = runtime.viewOnceMirror?.parseCommand?.(text, commandPrefix);
        if (viewUnicaCmd && !isFromMe) {
          const viewOnceResult = runtime.viewOnceMirror?.handleCommand?.({
            userId,
            remoteJid,
            args: viewUnicaCmd.args
          });
          if (viewOnceResult?.forbidden) {
            finalizeDecisionTrace(runtime, decisionTrace, { output: RESPONSE_OUTPUTS.IGNORED });
            continue;
          }
          if (viewOnceResult?.handled && viewOnceResult.reply) {
            await safeSendMessage(remoteJid, { text: viewOnceResult.reply });
            finalizeDecisionTrace(runtime, decisionTrace, { output: RESPONSE_OUTPUTS.COMMAND });
            continue;
          }
        }

        if (
          isViewOnceInbound &&
          !isFromMe &&
          runtime.viewOnceMirror?.store?.isEnabled?.()
        ) {
          void runtime.viewOnceMirror
            ?.mirrorIncoming?.({
              incoming,
              rawMessage: rawIncomingMessage,
              role,
              remoteJid,
              userId,
              pushName: incoming.pushName ?? null,
              isGroup,
              fallbackText: text,
              receiveSocket: socket
            })
            ?.catch?.((err) => {
              console.warn(`${waLogPrefix} viewonce mirror:`, err?.message ?? err);
            });
        }

        if (isGroup && participantId) {
          const rawParticipantJid = participantJid || extractParticipant(incoming);
          if (rawParticipantJid && /^\d{8,}$/.test(participantId)) {
            runtime.channelRegistry?.recordParticipantJid?.(remoteJid, participantId, rawParticipantJid);
          }
          if (participantPhone && participantJid.includes("@lid")) {
            runtime.channelRegistry?.recordParticipantLink?.(
              remoteJid,
              extractLocalPart(participantJid),
              participantPhone
            );
          }
        }

        if (tetoSlash && !isFromMe && (role !== "media" || botChatRole)) {
          const handled = await handleTetoSlashCommand({
            action: tetoSlash.action,
            userId,
            remoteJid,
            isGroup,
            activationStore: runtime.tetoActivation,
            groupEngagement: runtime.groupEngagement,
            socket,
            commandPrefix,
            abortGroupChannel: orchestrator?.abortGroupChannel
          });
          if (handled.handled) {
            finalizeDecisionTrace(runtime, decisionTrace, {
              activation: tetoSlash.action,
              output: RESPONSE_OUTPUTS.COMMAND
            });
            continue;
          }
        }

        if (parsedCommand?.command === "help") {
          if (role === "media" || role === "full") {
            await socket.sendMessage(remoteJid, {
              text: formatMediaCommandHelpText(runtime.defaults.commandPrefix)
            });
          }
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.COMMAND
          });
          continue;
        }

        if (parsedCommand?.command === "repertorio" && !isRepertorioRemoveSubcommand(parsedCommand)) {
          const reply = repertoireModeReplyText(
            runtime.stickerRepertoireMode,
            userId,
            parsedCommand.args?.[0] ?? "status"
          );
          await socket.sendMessage(remoteJid, { text: reply });
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.COMMAND
          });
          continue;
        }

        if (role === "media" && !botChatRole) {
          if (!parsedCommand && !tetosCmd && !hasMediaPayload) {
            finalizeDecisionTrace(runtime, decisionTrace, {
              output: RESPONSE_OUTPUTS.IGNORED
            });
            continue;
          }
        }

        if (role === "main" && parsedCommand && parsedCommand.command !== "repertorio") {
          const hint = String(runtime.defaults.whatsappStickerCommandsDisabledHint ?? "").trim();
          if (hint) {
              await socket.sendMessage(remoteJid, { text: hint });
          }
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.IGNORED
          });
          continue;
        }

        let historySnapshot = [];
        if (role !== "media" || botChatRole) {
          historySnapshot = runtime.shortTerm.getAll(sessionId);
        }
        let closeDecision = "open";

        if (!isFromMe) {
          orchestrator?.clearTypingGrace(userId);
        }
        const pushName = incoming.pushName?.trim();

        const contextInfo = extractContextInfo(unwrappedMessage);
        const stanzaId = contextInfo?.stanzaId ?? null;
        const quotedSnapshot = stanzaId ? messageSnapshotById.get(stanzaId) : null;
        const botPhone = botPhoneForHandler || extractPhone(botJid);
        const botActorIds = buildBotActorIds(runtime, botPhone, botJid);
        const quotedFromProto = extractQuotedText(contextInfo?.quotedMessage);
        const isReplyToBot = isQuotedMessageFromBot(contextInfo, {
          botJid,
          botPhone,
          snapshot: quotedSnapshot,
          botActorIds,
          messageIndex: chatMessageIndex,
          channelId: remoteJid,
          quotedText: quotedFromProto
        });
        if (isReplyToBot && stanzaId) {
          logThinking(runtime, {
            phase: "reply_to_bot",
            userId,
            remoteJid,
            detail: `quote id=${stanzaId} texto="${(quotedFromProto || quotedSnapshot?.text || "").slice(0, 80)}"`
          });
        }

        if (
          !isFromMe &&
          !parsedCommand &&
          !tetosCmd &&
          stanzaId &&
          isQuotedTetosOneShot(chatMessageIndex, remoteJid, stanzaId)
        ) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            tetosOneShotReply: true,
            output: RESPONSE_OUTPUTS.IGNORED
          });
          logThinking(runtime, {
            phase: "tetos_one_shot_reply",
            userId,
            remoteJid,
            detail: "reply na resposta do .tetos — ignorado (sem janela de conversa)"
          });
          continue;
        }

        const mentionHint = contextInfo?.mentionedJid ?? [];
        const identityIndex = buildIdentityIndex(runtime);
        if (text && (isGroup || mentionHint.length)) {
          text = normalizeIncomingMentions(text, identityIndex, mentionHint);
        }
        let isDirect = false;
        let isReply = Boolean(stanzaId);
        let groupEngagementActive = false;
        let groupAddressKind = "none";

        if (isGroup && !parsedCommand && !tetosCmd && !isFromMe) {
          const engagement = runtime.groupEngagement;
          if (engagement?.isMuted?.(remoteJid, userId)) {
            runtime.groupMemory?.append?.({
              id: incoming.key.id,
              channelId: remoteJid,
              userId,
              speakerName: pushName || null,
              text: text || `[${mediaKind}]`,
              addressedToTeto: false,
              ts: new Date().toISOString(),
              quotedMessageId: stanzaId || null
            });
            finalizeDecisionTrace(runtime, decisionTrace, {
              groupGate: "muted",
              output: RESPONSE_OUTPUTS.IGNORED
            });
            logThinking(runtime, {
              phase: "group_filtered",
              userId,
              remoteJid,
              detail: "calar ativo — ignorando menção/janela por 1 min"
            });
            continue;
          }

          const hasMention = botMentionedInJids(mentionHint, botJid, botPhone, { botActorIds });
          groupAddressKind = classifyTetoAddress(text, { hasMention, isReplyToBot });
          if (isReplyToBot) isReply = true;

          const windowActive = engagement?.isActive?.(remoteJid, userId) ?? false;
          const explicitAddress =
            groupAddressKind === "mention" ||
            groupAddressKind === "reply" ||
            groupAddressKind === "contextual";

          if (explicitAddress || isReplyToBot) {
            isDirect = explicitAddress;
            engagement?.touch?.(remoteJid, userId);
          } else if (windowActive) {
            groupEngagementActive = true;
            isDirect = false;
            engagement?.touch?.(remoteJid, userId);
          } else if (groupAddressKind === "name_ambiguous") {
            logThinking(runtime, {
              phase: "group_filtered",
              userId,
              remoteJid,
              detail: "nome 'teto' sem contexto de chamada — ignorado (subconsciente: não era pra mim)"
            });
          }

          const allowGroupReply = explicitAddress || groupEngagementActive;
          decisionTrace.groupGate = explicitAddress
            ? groupAddressKind
            : groupEngagementActive
              ? "engagement_window"
              : "ignored";
          addDecisionStep(decisionTrace, "group.gate", {
            groupAddressKind,
            explicitAddress,
            groupEngagementActive,
            allowGroupReply
          });

          runtime.groupMemory?.append?.({
            id: incoming.key.id,
            channelId: remoteJid,
            userId,
            speakerName: pushName || null,
            text: text || `[${mediaKind}]`,
            addressedToTeto: explicitAddress || groupEngagementActive,
            ts: new Date().toISOString(),
            quotedMessageId: stanzaId || null
          });

          if (incoming.key?.id && chatMessageIndex) {
            chatMessageIndex.append({
              channelId: remoteJid,
              messageId: incoming.key.id,
              actorId: userId,
              speakerName: pushName || null,
              text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
              isFromBot: false,
              remoteJid,
              quotedMessageId: stanzaId,
              participantJid: incoming.key?.participant ?? null
            });
          }

          if (!allowGroupReply) {
            finalizeDecisionTrace(runtime, decisionTrace, {
              output: RESPONSE_OUTPUTS.IGNORED
            });
            logThinking(runtime, {
              phase: "group_filtered",
              userId,
              remoteJid,
              detail: "registrado em groupMemory; sem resposta (sem menção/janela)"
            });
            continue;
          }
        } else {
          isReply = Boolean(stanzaId);
          decisionTrace.groupGate = isGroup ? decisionTrace.groupGate : "dm";
        }

        if (role !== "media" || botChatRole) {
          const channelScope = isGroup ? `group:${remoteJid}` : "direct";
          const heuristic = ChatService.decideClosure(text, historySnapshot);
          const trustBond = runtime.brainOrchestrator?.trust?.getBond?.(userId, channelScope) ?? null;
          const repetition = runtime.brainOrchestrator?.repetition?.getSnapshot?.(sessionId) ?? null;
          const profileForClose = runtime.longTerm.getProfile(userId, channelScope);
          const resolved = resolveCloseDecision({
            message: text,
            history: historySnapshot,
            heuristicDecision: heuristic,
            trustBond,
            repetition,
            isDirectTetoCall: ChatService.isDirectTetoCall(text),
            isDirectQuestion: ChatService.isLikelyQuestion(text),
            isDirectMention: isGroup ? isDirect : false,
            isVulnerable: detectVulnerability(text),
            resumedAfterClose: Boolean(profileForClose?.conversationClosedAt),
            wrongBotName: detectWrongBotNameVocative(text),
            sessionId
          });
          closeDecision = resolved.closeDecision ?? "none";
          logThinking(runtime, {
            phase: "close_decision",
            userId,
            remoteJid,
            detail: `decision=${closeDecision} phase=${resolved.analysis?.phase ?? "?"} conf=${(resolved.analysis?.confidence ?? 0).toFixed(2)}`
          });
        }

        if (isTetosCommand) {
          closeDecision = "open";
        }

        if (role !== "media" || botChatRole) {
          recordWaIdentity(runtime, {
            userId,
            remoteJid,
            participantJid: isGroup ? participantJid : remoteJid,
            participantPhone: isGroup ? participantPhone : null,
            pushName,
            channelId: remoteJid,
            isGroup
          });

          const profile = runtime.longTerm.getProfile(userId);
          if (pushName) {
            runtime.longTerm.updateProfile(userId, {
              facts: {
                ...(profile?.facts ?? {}),
                name: pushName,
                displayName: cleanDisplayName(pushName) || profile?.facts?.displayName
              }
            });
          }
          runtime.longTerm.updateProfile(userId, {
            facts: {
              ...(profile?.facts ?? {}),
              lastChannel: isGroup ? "group" : "direct",
              waRemoteJid: remoteJid,
              ...(isLikelyPhoneNumber(userId) ? { waPhone: userId } : {}),
              ...(remoteJid.includes("@lid")
                ? { waLid: extractLocalPart(remoteJid) }
                : {})
            }
          });
        }

        const quotedMessage =
          quotedFromProto ||
          (contextInfo?.quotedMessage ? extractText(contextInfo.quotedMessage).trim() : "") ||
          quotedSnapshot?.text ||
          "";
        const replyThreadContext =
          stanzaId && chatMessageIndex
            ? chatMessageIndex.buildReplyContext(remoteJid, stanzaId, 14)
            : null;

        try {
          if (unwrappedMessage?.imageMessage && incoming.key?.id) {
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.imageMessage,
              type: "image",
              id: `${incoming.key.id}-image`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            const visualDescription = await attachVisionTranscript(runtime, {
              filePath: path,
              mediaType: "image",
              userId,
              remoteJid,
              skipVision: skipVisionEnrichment
            });
            media = applyVisionFields(
              {
                type: "image",
                caption: unwrappedMessage.imageMessage?.caption ?? text,
                transcript: visualDescription,
                path
              },
              visualDescription,
              { skipVision: skipVisionEnrichment }
            );
          } else if (unwrappedMessage?.videoMessage && incoming.key?.id) {
            const isGif = Boolean(unwrappedMessage.videoMessage?.gifPlayback);
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.videoMessage,
              type: "video",
              id: `${incoming.key.id}-video`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            const visualDescription = await attachVisionTranscript(runtime, {
              filePath: path,
              mediaType: isGif ? "gif" : "video",
              isAnimated: isGif,
              userId,
              remoteJid,
              skipVision: skipVisionEnrichment
            });
            media = applyVisionFields(
              {
                type: isGif ? "gif" : "video",
                caption: unwrappedMessage.videoMessage?.caption ?? text,
                transcript: visualDescription,
                isAnimated: isGif,
                path
              },
              visualDescription,
              { skipVision: skipVisionEnrichment }
            );
          } else if (unwrappedMessage?.audioMessage && incoming.key?.id) {
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.audioMessage,
              type: "audio",
              id: `${incoming.key.id}-audio`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            let transcript = null;
            let transcriptSource = null;
            if (!skipVisionEnrichment) {
              const transcribed = await runtime.audioTranscriber?.transcribe?.({
                filePath: path,
                mimetype: unwrappedMessage.audioMessage?.mimetype,
                seconds: unwrappedMessage.audioMessage?.seconds
              });
              transcript =
                typeof transcribed === "string" ? transcribed : transcribed?.text ?? null;
              transcriptSource =
                typeof transcribed === "object" ? transcribed?.source ?? "fallback" : "fallback";
              if (transcript) {
                runtime.audioTranscriptions?.save?.({
                  userId,
                  channelId: remoteJid,
                  mediaPath: path,
                  transcript,
                  source: transcriptSource
                });
              }
            }
            media = {
              type: "audio",
              transcript,
              transcriptSource,
              caption: text,
              path
            };
          } else if (unwrappedMessage?.stickerMessage && incoming.key?.id) {
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.stickerMessage,
              type: "sticker",
              id: `${incoming.key.id}-sticker`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            const isAnimated = await probeStickerIsAnimated(path, {
              isAnimatedHint: unwrappedMessage.stickerMessage?.isAnimated
            });
            media = {
              type: "sticker",
              caption: text,
              isAnimated,
              path
            };
            if (!skipVisionEnrichment) {
              void attachVisionTranscript(runtime, {
                filePath: path,
                mediaType: "sticker",
                isAnimated,
                userId,
                remoteJid,
                skipVision: skipVisionEnrichment
              })
                .then((visualDescription) => {
                  if (!visualDescription) return;
                  const enriched = applyVisionFields(
                    { ...media, transcript: visualDescription },
                    visualDescription,
                    { skipVision: false }
                  );
                  syncIncomingMediaContext(runtime, {
                    remoteJid,
                    messageId: incoming.key.id,
                    userId,
                    pushName,
                    text,
                    media: enriched,
                    stanzaId,
                    participantJid: isGroup ? participantJid : null,
                    chatMessageIndex,
                    isGroup
                  });
                })
                .catch((err) => {
                  console.warn(`${waLogPrefix} sticker vision background:`, err?.message ?? err);
                });
            }
          } else if (unwrappedMessage?.documentMessage && incoming.key?.id) {
            const docHint = inferDocumentAsMedia(unwrappedMessage);
            if (docHint) {
              const persistType = docHint.type === "gif" ? "video" : docHint.type;
              const path = await persistMedia({
                downloadContentFromMessage,
                content: docHint.doc,
                type: persistType,
                id: `${incoming.key.id}-document`,
                basePath: runtime.defaults.whatsappMediaPath,
                preferredExt: fileExtFromDocumentMessage(docHint.doc),
                decryptMediaAs: "document"
              });
              if (docHint.type === "image") {
                const visualDescription = await attachVisionTranscript(runtime, {
                  filePath: path,
                  mediaType: "image",
                  userId,
                  remoteJid,
                  skipVision: skipVisionEnrichment
                });
                media = applyVisionFields(
                  {
                    type: "image",
                    caption: unwrappedMessage.documentMessage?.caption ?? text,
                    transcript: visualDescription,
                    path
                  },
                  visualDescription,
                  { skipVision: skipVisionEnrichment }
                );
              } else {
                const isGif = docHint.type === "gif";
                const visualDescription = await attachVisionTranscript(runtime, {
                  filePath: path,
                  mediaType: isGif ? "gif" : "video",
                  isAnimated: isGif,
                  userId,
                  remoteJid,
                  skipVision: skipVisionEnrichment
                });
                media = applyVisionFields(
                  {
                    type: isGif ? "gif" : "video",
                    caption: unwrappedMessage.documentMessage?.caption ?? text,
                    transcript: visualDescription,
                    isAnimated: isGif,
                    path
                  },
                  visualDescription,
                  { skipVision: skipVisionEnrichment }
                );
              }
            }
          }
        } catch (error) {
          runtime.logger?.log?.("whatsapp.media_error", {
            messageId: incoming.key?.id ?? null,
            error: error.message
          });
        }

        if (media?.path && media?.type) {
          mediaHistoryStore.add(remoteJid, {
            messageId: incoming.key?.id ?? null,
            userId,
            media
          });
        }

        if (incoming.key?.id && media?.type) {
          syncIncomingMediaContext(runtime, {
            remoteJid,
            messageId: incoming.key.id,
            userId,
            pushName,
            text,
            media,
            stanzaId,
            participantJid: incoming.key?.participant ?? null,
            chatMessageIndex,
            isGroup
          });
        }

        if (!isFromMe && media?.type === "sticker" && media?.path && incoming.key?.id) {
          const autoSaved = await tryAutoSaveIncomingSticker({
            runtime,
            repertoireModeStore: runtime.stickerRepertoireMode,
            userId,
            remoteJid,
            messageId: incoming.key.id,
            media,
            isForwarded: isForwardedMessage(contextInfo),
            pushName,
            basePath: runtime.defaults.stickersPath
          });
          if (autoSaved?.key) {
            console.log(
              `${waLogPrefix} auto-repertoire saved: ${autoSaved.key} from ${userId}${autoSaved.forwarded ? " (fwd)" : ""}${autoSaved.displayName ? ` — ${autoSaved.displayName}` : ""}`
            );
            runtime.logger?.log?.("whatsapp.sticker_repertoire_auto", {
              key: autoSaved.key,
              userId,
              remoteJid,
              messageId: incoming.key.id,
              forwarded: autoSaved.forwarded,
              displayName: autoSaved.displayName ?? null,
              visionSource: autoSaved.visionSource ?? null,
              autoNamed: autoSaved.autoNamed ?? false
            });
          } else if (runtime.stickerRepertoireMode?.isActive?.(userId)) {
            logRepertoireVision(runtime, "auto_save_no_result", {
              messageId: incoming.key.id,
              userId,
              transcript: media?.transcript ? String(media.transcript).slice(0, 120) : null
            });
          }
        }

        if (parsedCommand) {
          const commandMessageId = incoming.key?.id ?? null;
          if (
            parsedCommand.command === "repertorio" &&
            isRepertorioRemoveSubcommand(parsedCommand)
          ) {
            await handleRepertorioRemoveCommand({
              runtime,
              remoteJid,
              userId,
              stanzaId,
              send: (text) => safeSendMessage(remoteJid, { text })
            });
            finalizeDecisionTrace(runtime, decisionTrace, {
              output: RESPONSE_OUTPUTS.COMMAND
            });
            continue;
          }
          if (type === "append") {
            if (runtime.defaults.thinkingLogsEnabled) {
              console.log(
                `[audit.command] ${JSON.stringify({
                  ts: new Date().toISOString(),
                  status: "skip_append_replay",
                  commandName: parsedCommand.command,
                  messageId: commandMessageId,
                  remoteJid
                })}`
              );
            }
            finalizeDecisionTrace(runtime, decisionTrace, {
              output: RESPONSE_OUTPUTS.IGNORED
            });
            continue;
          }
          if (!processedCommandDeduper.claim(commandMessageId)) {
            if (runtime.defaults.thinkingLogsEnabled) {
              console.log(
                `[audit.command] ${JSON.stringify({
                  ts: new Date().toISOString(),
                  status: "skip_duplicate",
                  commandName: parsedCommand.command,
                  messageId: commandMessageId,
                  remoteJid
                })}`
              );
            }
            finalizeDecisionTrace(runtime, decisionTrace, {
              output: RESPONSE_OUTPUTS.IGNORED
            });
            continue;
          }
          try {
            const handled = await mediaCommandService.handle({
              incoming,
              parsedCommand,
              remoteJid,
              userId,
              media
            });
            if (handled) {
              finalizeDecisionTrace(runtime, decisionTrace, {
                output: RESPONSE_OUTPUTS.COMMAND
              });
              continue;
            }
          } catch (error) {
            if (isWaConnectionError(error)) {
              console.warn(`${waLogPrefix} comando ${parsedCommand.command} — conexao fechada`);
              continue;
            }
            throw error;
          }
        }

        if (role === "media" && !botChatRole) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.IGNORED
          });
          continue;
        }

        const activation = runtime.tetoActivation;
        if (!isGroup && runtime.groupEngagement?.isMuted?.(remoteJid, userId) && !isFromMe) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            groupGate: "muted",
            output: RESPONSE_OUTPUTS.IGNORED
          });
          logThinking(runtime, {
            phase: "dm_filtered",
            userId,
            remoteJid,
            detail: "calar ativo — ignorando mensagens por 1 min"
          });
          continue;
        }
        if (!isGroup && activation?.isActivationRequired?.() && isOwnerContact(runtime, remoteJid, userId)) {
          if (!activation.isDmActive(userId)) {
            activation.activateDm(userId, { activatedBy: userId, autoOwner: true });
            logThinking(runtime, {
              phase: "activation_auto",
              userId,
              remoteJid,
              detail: "dona reconhecida — dm ativado automaticamente"
            });
          }
        }
        if (!isGroup && activation) {
          activation.touchDm(userId);
          const dmActive = activation.isDmActive(userId);
          if (!dmActive && !isTetosCommand) {
            finalizeDecisionTrace(runtime, decisionTrace, {
              activation: "dm_blocked",
              output: botChatRole && !isFromMe ? RESPONSE_OUTPUTS.TEXT : RESPONSE_OUTPUTS.IGNORED
            });
            logThinking(runtime, {
              phase: "activation_blocked",
              userId,
              remoteJid,
              detail: `dm nao ativado — ${formatTetoActivationCommand("teto-ativar", runtime.defaults.commandPrefix)}`
            });
            if (botChatRole && !isFromMe) {
              await safeSendMessage(remoteJid, {
                text: `PV ainda não ativado. Manda ${formatTetoActivationCommand("teto-ativar", runtime.defaults.commandPrefix)} para eu responder aqui.`
              });
            }
            continue;
          }
        }
        if (isGroup && activation && !activation.isGroupActive(remoteJid) && !isTetosCommand) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            activation: "group_blocked",
            output: RESPONSE_OUTPUTS.IGNORED
          });
          logThinking(runtime, {
            phase: "activation_blocked",
            userId,
            remoteJid,
            detail: `grupo nao ativado — ${formatTetoActivationCommand("teto-grupo-ativar", runtime.defaults.commandPrefix)}`
          });
          continue;
        }

        if (!isFromMe) {
          logIncomingAudit(runtime, {
            remoteJid,
            userId,
            participantId,
            isGroup,
            text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
            links,
            media,
            quotedMessage,
            isReply: Boolean(stanzaId),
            isDirectMention: isGroup ? isDirect : false,
            mentionHint,
            closeDecision,
            messageId: incoming.key?.id ?? null,
            pushName
          });
        }

        if (isFromMe) {
          if (incoming.key?.id && chatMessageIndex?.get(remoteJid, incoming.key.id)) {
            finalizeDecisionTrace(runtime, decisionTrace, {
              output: RESPONSE_OUTPUTS.IGNORED
            });
            continue;
          }
          logOutgoingAudit(runtime, {
            remoteJid,
            userId,
            participantId,
            isGroup,
            text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
            links,
            media,
            quotedMessage,
            isReply: Boolean(stanzaId),
            isDirectMention: isGroup ? isDirect : false,
            mentionHint,
            closeDecision: "self_message",
            messageId: incoming.key?.id ?? null,
            pushName
          });
          const fromMeActorId = resolveOwnerActorId(runtime) || userId || "self";
          runtime.eventLedger?.append?.({
            eventType: "message.outgoing",
            actorId: fromMeActorId,
            userId: fromMeActorId,
            remoteJid,
            participantId,
            isGroup,
            isReply: Boolean(stanzaId),
            hasQuotedMessage: Boolean(quotedMessage),
            messageId: incoming.key?.id ?? null,
            mediaType: media?.type ?? null,
            contentClass: classifyContent(text),
            links
          });
          runtime.behaviorProfiler?.record?.({
            ts: new Date().toISOString(),
            eventType: "message.incoming",
            actorId: fromMeActorId,
            remoteJid,
            mediaType: media?.type ?? null,
            links
          });
          if (incoming.key?.id) {
            const isBotOwn =
              role === "media" || botChatRole || (role === "full" && runtime.defaults.replyEnabled);
            const outActorId = isBotOwn ? "teto" : fromMeActorId;
            rememberWaMessage(waMessageById, incoming, rawIncomingMessage);
            messageSnapshotById.set(
              incoming.key.id,
              buildMessageSnapshot({
                messageId: incoming.key.id,
                remoteJid,
                actorId: outActorId,
                text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
                mediaType: media?.type ?? null,
                quotedMessage
              })
            );
            chatMessageIndex.append({
              channelId: remoteJid,
              messageId: incoming.key.id,
              actorId: outActorId,
              speakerName: isBotOwn ? "Teto" : pushName || null,
              text: text || media?.transcript || media?.caption || `[${mediaKind}]`,
              isFromBot: isBotOwn,
              remoteJid,
              quotedMessageId: stanzaId,
              participantJid: incoming.key?.participant ?? null
            });
            if (isGroup && isBotOwn) {
              runtime.groupMemory?.append?.({
                id: incoming.key.id,
                channelId: remoteJid,
                userId: "teto",
                speakerName: "Teto",
                text: text || `[${mediaKind}]`,
                addressedToTeto: true,
                ts: new Date().toISOString(),
                quotedMessageId: stanzaId || null
              });
            }
          }
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.IGNORED
          });
          continue;
        }

        runtime.logger?.log?.("whatsapp.incoming", {
          remoteJid,
          userId,
          sessionId,
          isGroup,
          hasQuotedMessage: Boolean(quotedMessage),
          mediaType: media?.type ?? null,
          messageId: incoming.key?.id ?? null
        });
        runtime.eventLedger?.append?.({
          eventType: "message.incoming",
          actorId: userId,
          userId,
          remoteJid,
          participantId,
          isGroup,
          isReply: Boolean(stanzaId),
          hasQuotedMessage: Boolean(quotedMessage),
          messageId: incoming.key?.id ?? null,
          mediaType: media?.type ?? null,
          contentClass: classifyContent(text),
          links,
          pushName: incoming.pushName ?? null
        });
        runtime.behaviorProfiler?.record?.({
          ts: new Date().toISOString(),
          eventType: "message.incoming",
          actorId: userId,
          remoteJid,
          mediaType: media?.type ?? null,
          links
        });
        if (incoming.key?.id) {
          const indexedText = formatMediaInputText({ text, media });
          rememberWaMessage(waMessageById, incoming, rawIncomingMessage);
          messageSnapshotById.set(
            incoming.key.id,
            buildMessageSnapshot({
              messageId: incoming.key.id,
              remoteJid,
              actorId: userId,
              text: indexedText,
              mediaType: media?.type ?? null,
              quotedMessage
            })
          );
          if (!chatMessageIndex?.get(remoteJid, incoming.key.id)) {
            chatMessageIndex.append({
              channelId: remoteJid,
              messageId: incoming.key.id,
              actorId: userId,
              speakerName: pushName || null,
              text: indexedText,
              isFromBot: false,
              remoteJid,
              quotedMessageId: stanzaId,
              participantJid: incoming.key?.participant ?? null
            });
          }
        }
        logThinking(runtime, {
          phase: "event_captured",
          userId,
          remoteJid,
          detail: `media=${media?.type ?? "none"} links=${links.length} class=${classifyContent(text)}`
        });
        runtime.metrics?.increment?.("whatsapp.incoming");
        if (media?.type) {
          runtime.metrics?.increment?.(`whatsapp.media.${media.type}`);
        }

        let effectiveMessage = formatMediaInputText({ text, media });
        if (isTetosCommand) {
          effectiveMessage = tetosMessage;
        }

        const isOwner = isOwnerContact(runtime, remoteJid, userId);

        if (
          await maybeRedirectOwnerToBotDm({
            remoteJid,
            userId,
            text,
            isFromMe,
            isGroup
          })
        ) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.TEXT
          });
          continue;
        }

        runtime.brainOrchestrator?.life?.sleep?.checkTemporaryWake?.();
        runtime.brainOrchestrator?.reconcileSleepFromSchedule?.();
        const sleepSnap = runtime.brainOrchestrator?.life?.sleep?.getSnapshot?.() ?? {};
        const wasTempAwakeBefore = Boolean(sleepSnap.isTemporarilyAwake);
        let sleepDisturbedWake = false;

        if (sleepSnap.isAvailable === false && !parsedCommand && !isTetosCommand) {
          const flood = trackSleepDisturbanceFlood(sessionId, effectiveMessage);
          const disturbScore = scoreSleepDisturbance(effectiveMessage, { floodCount: flood.count });
          const disturbResult = runtime.brainOrchestrator?.life?.sleep?.attemptDisturbanceWake?.({
            score: disturbScore,
            floodCount: flood.count
          });

          if (disturbResult) {
            sleepDisturbedWake = true;
            clearSleepDisturbanceFlood(sessionId);
            logThinking(runtime, {
              phase: "sleep_disturbed_wake",
              userId,
              remoteJid,
              detail: `acordou no susto (score ${disturbScore.toFixed(2)}, flood ${flood.count})`
            });
          } else {
            runtime.sleepMessageBuffer?.append?.(sessionId, {
              message: effectiveMessage,
              userId,
              sessionId,
              remoteJid,
              messageKey: incoming.key ? { ...incoming.key } : undefined,
              quotedMessageId: stanzaId ?? null,
              isReply: isReply || isReplyToBot,
              pushName: pushName || null,
              participantId: isGroup ? participantId : null,
              media
            });
            finalizeDecisionTrace(runtime, decisionTrace, {
              pipelineMode: RESPONSE_MODES.SLEEP_HOLD,
              output: RESPONSE_OUTPUTS.SILENT
            });
            logThinking(runtime, {
              phase: "sleep_hold",
              userId,
              remoteJid,
              detail: `dormindo (${sleepSnap.state ?? "?"}) — guardada p/ catch-up (${runtime.sleepMessageBuffer?.peekCount?.(sessionId) ?? 0} na fila)`
            });
            continue;
          }
        }

        if (
          wasTempAwakeBefore &&
          !parsedCommand &&
          !isTetosCommand &&
          !isFromMe &&
          runtime.brainOrchestrator?.life?.sleep?.isTemporarilyAwake?.()
        ) {
          runtime.brainOrchestrator?.life?.sleep?.extendTemporaryWakeOnInteraction?.();
        }

        const sleepSnapAfter = runtime.brainOrchestrator?.life?.sleep?.getSnapshot?.() ?? sleepSnap;

        const mediaOnlyInbound = hasMediaPayload && !String(text ?? "").trim() && !parsedCommand && !isTetosCommand;
        const hasVisionOrTranscript = Boolean(String(media?.transcript ?? "").trim());
        const allowMediaConversation = shouldRespondToMediaOnly({
          media,
          isDirect,
          isReply: isReply || isReplyToBot,
          isReplyToBot,
          hasVisionOrTranscript,
          userId
        });
        if (mediaOnlyInbound && !allowMediaConversation) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            pipelineMode: RESPONSE_MODES.MEDIA_WAIT,
            output: RESPONSE_OUTPUTS.SILENT
          });
          logThinking(runtime, {
            phase: "media_wait",
            userId,
            remoteJid,
            detail: "midia sem contexto/spam — ignorando ou aguardando comando"
          });
          continue;
        }

        const repertoireHandledAt = runtime.repertoireHandledMessageIds?.get?.(incoming.key?.id);
        if (
          mediaOnlyInbound &&
          media?.type === "sticker" &&
          repertoireHandledAt &&
          Date.now() - repertoireHandledAt < 5 * 60 * 1000
        ) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            pipelineMode: RESPONSE_MODES.FULL,
            output: RESPONSE_OUTPUTS.IGNORED
          });
          continue;
        }

        if (
          !parsedCommand &&
          !isFromMe &&
          (await tryHandleRepertoireRemoveConfirmation({
            runtime,
            remoteJid,
            userId,
            text,
            send: (msg) => safeSendMessage(remoteJid, { text: msg })
          }))
        ) {
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.COMMAND
          });
          continue;
        }

        scheduleWithSleepCatchUp({
          remoteJid,
          message: effectiveMessage,
          userId,
          sessionId,
          isOwner,
          mainObserveOnly,
          channelId: remoteJid,
          isGroup,
          participants: (() => {
            const ch = runtime.channelRegistry.get(remoteJid);
            if (ch.participants?.length) return ch.participants;
            return isGroup && participantId ? [participantId] : [userId];
          })(),
          isDirectMention: isGroup ? isDirect : false,
          groupEngagementActive: isTetosCommand ? false : isGroup ? groupEngagementActive : false,
          groupAddressKind: isGroup ? groupAddressKind : null,
          groupPriorityAddress: isTetosCommand
            ? true
            : isGroup
              ? isGroupPriorityEntry({
                  isDirectMention: isDirect,
                  isReplyToBot,
                  groupAddressKind,
                  tetosCommand: false
                })
              : false,
          isReply: isReply || isReplyToBot,
          isReplyToBot,
          quotedMessage,
          quotedMessageId: stanzaId,
          replyThreadContext,
          media,
          closeDecision,
          messageKey: incoming.key ? { ...incoming.key } : undefined,
          pushName: pushName || null,
          participantId: isGroup ? participantId : null,
          participantJid: isGroup ? extractParticipant(incoming) || null : null,
          decisionTrace,
          preferQuoteReply: false,
          tetosCommand: isTetosCommand,
          sleepDisturbedWake,
          sleepTemporarilyAwake: Boolean(sleepSnapAfter.isTemporarilyAwake),
          tempWakeGrogginess: sleepSnapAfter.tempWakeGrogginess ?? 0,
          tempWakeExtensionCount: sleepSnapAfter.tempWakeExtensionCount ?? 0,
          sleepGroggy: sleepSnapAfter.state === "groggy"
        });
      } catch (error) {
        console.error("[whatsapp] message handler error:", error.message);
      }
    }
  });

  if (role !== "media" || botChatRole) {
    socket.ev.on("messages.update", (updates = []) => {
      for (const update of updates) {
        const messageId = update?.key?.id ?? null;
        const before = messageId ? messageSnapshotById.get(messageId) : null;
        const updatedText = extractUpdatedText(update);
        const isEdit = Boolean(updatedText && before && updatedText !== before.text);
        if (isEdit) {
          const reason = inferEditReason(before?.text, updatedText);
          if (runtime?.defaults?.thinkingLogsEnabled) {
            console.log(`[audit.edit] ${JSON.stringify({
              ts: new Date().toISOString(),
              messageId,
              remoteJid: update?.key?.remoteJid ?? null,
              actorId: before?.actorId ?? extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? ""),
              before: before?.text ?? null,
              after: updatedText,
              reason
            })}`);
          }
          runtime.eventLedger?.append?.({
            eventType: "message.edited",
            messageId,
            remoteJid: update?.key?.remoteJid ?? null,
            actorId: before?.actorId ?? extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? ""),
            beforeText: before?.text ?? null,
            afterText: updatedText,
            reason
          });
          messageSnapshotById.set(
            messageId,
            {
              ...before,
              text: updatedText,
              ts: new Date().toISOString()
            }
          );
        }
        if (runtime?.defaults?.thinkingLogsEnabled) {
          console.log(`[audit.update] ${JSON.stringify({
            ts: new Date().toISOString(),
            messageId,
            remoteJid: update?.key?.remoteJid ?? null,
            participant: update?.key?.participant ?? null,
            status: update?.update?.status ?? null
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "message.update",
          messageId,
          remoteJid: update?.key?.remoteJid ?? null,
          actorId: extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? "")
        });
        runtime.behaviorProfiler?.record?.({
          ts: new Date().toISOString(),
          eventType: "message.update",
          actorId: extractPhone(update?.key?.participant ?? update?.key?.remoteJid ?? ""),
          remoteJid: update?.key?.remoteJid ?? null
        });
      }
    });

    socket.ev.on("message-receipt.update", (updates = []) => {
      for (const update of updates) {
        if (runtime?.defaults?.thinkingLogsEnabled) {
          console.log(`[audit.receipt] ${JSON.stringify({
            ts: new Date().toISOString(),
            messageId: update?.key?.id ?? null,
            remoteJid: update?.key?.remoteJid ?? null,
            receipt: update?.receipt ?? null
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "message.receipt_update",
          messageId: update?.key?.id ?? null,
          remoteJid: update?.key?.remoteJid ?? null,
          receipt: update?.receipt ?? null
        });
      }
    });

    socket.ev.on("messages.reaction", (reactions = []) => {
      for (const reaction of reactions) {
        const actorId = extractPhone(reaction?.key?.participant ?? reaction?.key?.remoteJid ?? "");
        if (runtime?.defaults?.thinkingLogsEnabled) {
          console.log(`[audit.reaction] ${JSON.stringify({
            ts: new Date().toISOString(),
            actorId,
            remoteJid: reaction?.key?.remoteJid ?? null,
            messageId: reaction?.key?.id ?? null,
            reactionText: reaction?.reaction?.text ?? null
          })}`);
        }
        runtime.eventLedger?.append?.({
          eventType: "message.reaction",
          actorId,
          remoteJid: reaction?.key?.remoteJid ?? null,
          messageId: reaction?.key?.id ?? null,
          reactionText: reaction?.reaction?.text ?? null
        });
        runtime.behaviorProfiler?.record?.({
          ts: new Date().toISOString(),
          eventType: "message.reaction",
          actorId,
          remoteJid: reaction?.key?.remoteJid ?? null
        });
      }
    });
  }
}
