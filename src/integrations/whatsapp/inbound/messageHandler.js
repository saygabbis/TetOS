import { createPresenceManager } from "../conversation/presenceManager.js";
import { touchInboundActivity } from "../connection/inboundLiveness.js";
import { jidNormalizedUser, downloadContentFromMessage, normalizeMessageContent } from "baileys";
import { persistMedia, fileExtFromDocumentMessage } from "../media/mediaStore.js";
import { RESPONSE_MODES, RESPONSE_OUTPUTS } from "../../../core/pipeline/responseModes.js";
import { addDecisionStep, createDecisionTrace, finalizeDecisionTrace } from "../../../infra/observability/decisionTrace.js";
import { ChatService } from "../../../modules/chat/chatService.js";
import { resolveCloseDecision } from "../../../core/brain/ConversationPhaseEngine.js";
import { detectWrongBotNameVocative } from "./tetoNameDetect.js";
import { hasVocativeToTeto } from "../../../modules/chat/coherenceGuards.js";
import { detectVulnerability } from "../../../core/brain/vulnerabilityDetect.js";
import { ChatCommandQueue } from "./chatCommandQueue.js";
import { ChatMediaHistoryStore } from "../media/chatMediaHistoryStore.js";
import { MediaProcessor } from "../../../core/media/mediaProcessor.js";
import { probeStickerIsAnimated } from "../../../core/media/stickerAnimation.js";
import { detectConfirmationReply } from "../../../core/operations/confirmationIntent.js";
import { formatMediaInputText } from "../../../core/channels/mediaTimelineEnrich.js";
import { ChatMessageIndex } from "./chatMessageIndex.js";
import { mentionedJidsIncludeBot, classifyTetoAddress, extractContextInfo, extractQuotedText, isQuotedMessageFromBot } from "./messageContext.js";
import { buildBotActorIds } from "../../../core/channels/botIdentity.js";
import { parseTetoSlashCommand, handleTetoSlashCommand, formatTetoActivationCommand } from "../commands/tetoSlashCommands.js";
import { parseTetosCommand, resolveTetosMessage, formatTetosUsage, isQuotedTetosOneShot } from "../commands/tetosCommand.js";
import { formatWhatsAppHelpText as formatMediaCommandHelpText, parseWhatsAppCommand as parseMediaCommand } from "../commands/mediaCommandParser.js";
import { buildWhatsappIdentitySnapshot } from "../connection/whatsappIdentityContract.js";
import { MediaCommandService } from "../commands/mediaCommandService.js";
import { tryAutoSaveIncomingSticker, isForwardedMessage, logRepertoireVision, findRepertoireEntryByMessageId, removeStickerFromRepertoire, isBuiltinRepertoireKey } from "../media/stickerRepertoire.js";
import { canonicalSessionId, canonicalUserId, isOwnerContact, resolveOwnerActorId } from "../../../core/channels/userActivity.js";
import { buildIdentityIndex, cleanDisplayName, extractLocalPart, isLikelyPhoneNumber, normalizeIncomingMentions, recordWaIdentity } from "../../../core/channels/waIdentity.js";
import { createProcessedCommandDeduper, isStaleHistoryReplay } from "./processedCommandDeduper.js";
import { shouldRespondToMediaOnly } from "../../../core/media/mediaSpamGate.js";
import { detectHushRequest } from "../../../core/channels/hushRequest.js";
import { enrichMediaVision } from "../../../modules/vision/mediaVisionEnrich.js";
import { isViewOnceMessage, isViewOnceStub } from "../media/viewOnceDetect.js";
import { isGroupPriorityEntry } from "../conversation/groupTurnPlanner.js";
import { scoreSleepDisturbance, sleepDisturbanceFloodWindowMs } from "../../../core/life/sleepDisturbanceDetect.js";
import { applyVisionFields, extractPhone, isWaConnectionError, logThinking } from "./waHandlerUtils.js";
import { createConversationOrchestrator } from "../conversation/conversationOrchestrator.js";

/** Alinha ao Baileys: documento com legenda vem em `documentWithCaptionMessage`, não só em `documentMessage`. */
function unwrapMessage(message = {}) {
  const normalized = normalizeMessageContent(message);
  return normalized ?? message ?? {};
}

function firstNonEmptyText(...candidates) {
  for (const value of candidates) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function extractText(message = {}) {
  const unwrapped = unwrapMessage(message);
  const mediaCaption = firstNonEmptyText(
    unwrapped?.imageMessage?.caption,
    unwrapped?.videoMessage?.caption,
    unwrapped?.documentMessage?.caption
  );
  if (mediaCaption) return mediaCaption;
  return firstNonEmptyText(
    unwrapped?.conversation,
    unwrapped?.extendedTextMessage?.text,
    unwrapped?.stickerMessage?.fileName,
    unwrapped?.buttonsResponseMessage?.selectedButtonId,
    unwrapped?.listResponseMessage?.title
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


function startChatVision(runtime, media, { userId, remoteJid, skipVision = false } = {}) {
  if (skipVision || !media?.path) return null;
  if (media.type === "audio") return null;
  const visualTypes = new Set(["image", "sticker", "gif", "video"]);
  if (!visualTypes.has(media.type)) return null;
  const promise = attachVisionTranscript(runtime, {
    filePath: media.path,
    mediaType: media.type,
    isAnimated: Boolean(media.isAnimated),
    userId,
    remoteJid,
    skipVision
  });
  media.visionPromise = promise;
  return promise;
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


const PRESENCE_RESUBSCRIBE_MS = 10 * 60 * 1000;

/** Quem manda msg sem ter ativado o PV recebe a instrução no máximo uma vez nesse intervalo. */
const ACTIVATION_HINT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function registerMessageHandler({ socket, runtime, role = "full" }) {
  if (socket.__tetosHandlerRegistered) return;
  socket.__tetosHandlerRegistered = true;

  runtime.__waHandlerEpoch = (runtime.__waHandlerEpoch ?? 0) + 1;
  const handlerEpoch = runtime.__waHandlerEpoch;
  if (role !== "media") {
    runtime.waPresenceSocket = socket;
    runtime.waPresence ??= createPresenceManager({ getSocket: () => runtime.waPresenceSocket });
    runtime.waPresence.reset();
  }
  const isCurrentHandler = () => runtime.__waHandlerEpoch === handlerEpoch;

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
  runtime.__waHandlerState ??= {};
  runtime.__waHandlerState[role] ??= {};
  const shared = runtime.__waHandlerState[role];
  shared.messageSnapshotById ??= new Map();
  shared.waMessageById ??= new Map();
  shared.seenMessageIds ??= new Map();
  shared.ownerRedirectDedupe ??= new Map();
  shared.activationHintAt ??= new Map();
  // Por socket: a inscrição de presença não sobrevive a reconexão.
  shared.presenceSubscribedAt = new Map();
  shared.processedCommandDeduper ??= createProcessedCommandDeduper();
  shared.mediaHistoryStore ??= new ChatMediaHistoryStore(runtime.defaults.commandMediaHistoryLimit);
  const messageSnapshotById = shared.messageSnapshotById;
  const waMessageById = shared.waMessageById;
  const commandQueue = new ChatCommandQueue();
  const mediaHistoryStore = shared.mediaHistoryStore;
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
  const wantsOrchestrator = !(role === "media" && !botChatRole);
  let orchestrator = wantsOrchestrator ? shared.orchestrator ?? null : null;
  const reusingOrchestrator = Boolean(orchestrator);
  if (wantsOrchestrator && !orchestrator) {
    orchestrator = createConversationOrchestrator(socket, runtime, {
      chatMessageIndex,
      botJid: botJidForHandler,
      botPhone: botPhoneForHandler,
      logPrefix: waLogPrefix,
      mediaHistoryStore,
      mediaCommandService,
      getMediaCommandService: () => shared.mediaCommandService,
      getWaMessageById: (id) => waMessageById.get(id) ?? null
    });
    shared.orchestrator = orchestrator;
    runtime.waOrchestrator = orchestrator;
  }
  shared.mediaCommandService = mediaCommandService;
  const seenMessageIds = shared.seenMessageIds;
  const ownerRedirectDedupe = shared.ownerRedirectDedupe;
  const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;
  const processedCommandDeduper = shared.processedCommandDeduper;
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
    const buffered = runtime.deferredInbox?.flush?.(entry.sessionId);
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

  function deliverPendingSleepCatchUp() {
    if (!orchestrator) return 0;
    // Só o que já está na hora — reconexão de madrugada não pode acordar ninguém.
    const pending = runtime.deferredInbox?.drainDue?.() ?? [];
    if (!pending.length) return 0;
    console.log(
      `${waLogPrefix} pegou o celular — ${pending.length} conversa(s) que tinham ficado pra depois`
    );
    for (const entry of pending) {
      orchestrator.scheduleIncoming({
        ...entry,
        channelId: entry.channelId ?? entry.remoteJid,
        sleepCatchUp: true,
        sleepCatchUpCount: entry.sleepCatchUpCount ?? entry.batchedCount ?? 1,
        closeDecision: entry.closeDecision ?? "open",
        preferQuoteReply: false
      });
    }
    return pending.length;
  }

  if (orchestrator) {
    runtime.deliverSleepCatchUp = deliverPendingSleepCatchUp;
    if (!runtime._sleepCatchUpListenerBound && runtime.brainOrchestrator?.bus?.on) {
      runtime._sleepCatchUpListenerBound = true;
      runtime.brainOrchestrator.bus.on("sleep.available", () => {
        try {
          runtime.deliverSleepCatchUp?.();
        } catch (error) {
          console.warn(`${waLogPrefix} sleep catch-up falhou:`, error?.message ?? error);
        }
      });
    }
    if (!runtime._deferredInboxTimer) {
      runtime._deferredInboxTimer = setInterval(() => {
        try {
          runtime.deliverSleepCatchUp?.();
        } catch (error) {
          console.warn(`${waLogPrefix} entrega adiada falhou:`, error?.message ?? error);
        }
      }, 20_000);
      runtime._deferredInboxTimer.unref?.();
    }
    deliverPendingSleepCatchUp();
  }

  console.log(
    `${waLogPrefix} handler ${reusingOrchestrator ? "religado (reconnect, mesma fila)" : "ativo"}${
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
    socket.ev.on("presence.update", (update) => {
      if (!isCurrentHandler()) return;
      orchestrator.onPresenceUpdate(update);
    });
  }

  /**
   * O WhatsApp só manda "digitando…" de um chat depois de presenceSubscribe — sem isso a Teto nunca
   * sabia que a pessoa ainda estava escrevendo. Renova a cada 10 min por chat.
   */
  function ensurePresenceSubscription(jid) {
    if (!jid || typeof socket.presenceSubscribe !== "function") return;
    const last = shared.presenceSubscribedAt.get(jid) ?? 0;
    if (Date.now() - last < PRESENCE_RESUBSCRIBE_MS) return;
    shared.presenceSubscribedAt.set(jid, Date.now());
    socket.presenceSubscribe(jid).catch(() => shared.presenceSubscribedAt.delete(jid));
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
    if (!isCurrentHandler()) return;
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
        const commandPrefix = runtime.defaults.commandPrefix;
        let parsedCommand = parseMediaCommand(text, commandPrefix);
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
            if (messageKeyId) seenMessageIds.delete(messageKeyId);
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
          orchestrator?.clearTypingGrace(remoteJid, isGroup ? participantJid : null);
          ensurePresenceSubscription(remoteJid);
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
          if (!parsedCommand) {
            parsedCommand = parseMediaCommand(text, commandPrefix);
          }
        }

        if (parsedCommand && !isFromMe) {
          orchestrator?.abortPendingMediaHold(sessionId, { remoteJid, userId });
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
          if (isStaleHistoryReplay(type, incoming)) {
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
          void mediaCommandService
            .handle({
              incoming,
              parsedCommand,
              remoteJid,
              userId,
              media
            })
            .catch((error) => {
              if (isWaConnectionError(error)) {
                console.warn(`${waLogPrefix} comando ${parsedCommand.command} — conexao fechada`);
                return;
              }
              console.warn(
                `${waLogPrefix} comando ${parsedCommand.command} falhou:`,
                error?.message ?? error
              );
            });
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.COMMAND
          });
          continue;
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

          const hasMention = mentionedJidsIncludeBot(mentionHint, {
            botJid,
            botPhone,
            botActorIds,
            identityIndex
          });
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

        if (!isFromMe && (role !== "media" || botChatRole) && !parsedCommand && !tetosCmd) {
          const channelScope = identitySnapshot.channelScope ?? (isGroup ? `group:${remoteJid}` : "direct");
          const heuristic = ChatService.decideClosure(text, historySnapshot);
          const trustBond = runtime.brainOrchestrator?.trust?.getBond?.(userId, channelScope) ?? null;
          const repetition = runtime.brainOrchestrator?.repetition?.getSnapshot?.(sessionId) ?? null;
          const profileForClose = runtime.longTerm.getProfile(userId, channelScope);
          const lastMessageAt = runtime.timeStore?.getLastMessage?.(userId, sessionId);
          const gapSinceLastMs = lastMessageAt ? Math.max(0, Date.now() - Date.parse(lastMessageAt)) : null;
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
            gapSinceLastMs,
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
              // JID do grupo não é o contato da pessoa (quebrava @menção e iniciativa no PV).
              ...(isGroup ? {} : { waRemoteJid: remoteJid }),
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

        const deferVisionForCommand = Boolean(parsedCommand);
        try {
          if (unwrappedMessage?.imageMessage && incoming.key?.id) {
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.imageMessage,
              type: "image",
              id: `${incoming.key.id}-image`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            media = {
              type: "image",
              caption: unwrappedMessage.imageMessage?.caption ?? text,
              path
            };
          } else if (unwrappedMessage?.videoMessage && incoming.key?.id) {
            const isGif = Boolean(unwrappedMessage.videoMessage?.gifPlayback);
            const path = await persistMedia({
              downloadContentFromMessage,
              content: unwrappedMessage.videoMessage,
              type: "video",
              id: `${incoming.key.id}-video`,
              basePath: runtime.defaults.whatsappMediaPath
            });
            media = {
              type: isGif ? "gif" : "video",
              caption: unwrappedMessage.videoMessage?.caption ?? text,
              isAnimated: isGif,
              path
            };
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
            if (!skipVisionEnrichment && !deferVisionForCommand) {
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
              const isGif = docHint.type === "gif";
              media = {
                type: docHint.type === "gif" ? "gif" : docHint.type,
                caption: unwrappedMessage.documentMessage?.caption ?? text,
                ...(docHint.type !== "image" ? { isAnimated: isGif } : {}),
                path
              };
            }
          }
        } catch (error) {
          runtime.logger?.log?.("whatsapp.media_error", {
            messageId: incoming.key?.id ?? null,
            error: error.message
          });
        }

        if (!isFromMe && media?.path && media?.type) {
          mediaHistoryStore.add(remoteJid, {
            messageId: incoming.key?.id ?? null,
            userId,
            media
          });
        }

        let mediaVisionPromise = null;
        if (
          media?.path &&
          !parsedCommand &&
          !isFromMe &&
          !skipVisionEnrichment &&
          media.type !== "audio"
        ) {
          mediaVisionPromise = startChatVision(runtime, media, {
            userId,
            remoteJid,
            skipVision: false
          });
          if (mediaVisionPromise) {
            mediaVisionPromise
              .then((visualDescription) => {
                if (!visualDescription || !incoming.key?.id) return;
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
                  participantJid: incoming.key?.participant ?? null,
                  chatMessageIndex,
                  isGroup
                });
              })
              .catch((err) => {
                console.warn(`${waLogPrefix} vision background:`, err?.message ?? err);
              });
          }
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

        if (!isFromMe && !parsedCommand && media?.type === "sticker" && media?.path && incoming.key?.id) {
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
          orchestrator?.abortPendingMediaHold(sessionId, { remoteJid, userId });
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
          if (isStaleHistoryReplay(type, incoming)) {
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
          void mediaCommandService
            .handle({
              incoming,
              parsedCommand,
              remoteJid,
              userId,
              media
            })
            .catch((error) => {
              if (isWaConnectionError(error)) {
                console.warn(`${waLogPrefix} comando ${parsedCommand.command} — conexao fechada`);
                return;
              }
              console.warn(
                `${waLogPrefix} comando ${parsedCommand.command} falhou:`,
                error?.message ?? error
              );
            });
          finalizeDecisionTrace(runtime, decisionTrace, {
            output: RESPONSE_OUTPUTS.COMMAND
          });
          continue;
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
          // Auto-ativa a dona — mas respeita /teto-desativar explícito (antes religava na msg seguinte).
          if (!activation.isDmActive(userId) && !activation.isDmExplicitlyOff?.(userId)) {
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
            // Instrução de ativação: no modo single o socket "full" é o chat da Teto (antes só o dual avisava).
            // Quem desativou de propósito já sabe como religar — sem instrução repetida.
            const canHint = (botChatRole || role === "full") && !isFromMe && !activation.isDmExplicitlyOff?.(userId);
            const lastHintAt = shared.activationHintAt.get(userId) ?? 0;
            const shouldHint = canHint && Date.now() - lastHintAt >= ACTIVATION_HINT_COOLDOWN_MS;
            finalizeDecisionTrace(runtime, decisionTrace, {
              activation: "dm_blocked",
              output: shouldHint ? RESPONSE_OUTPUTS.TEXT : RESPONSE_OUTPUTS.IGNORED
            });
            logThinking(runtime, {
              phase: "activation_blocked",
              userId,
              remoteJid,
              detail: `dm nao ativado — ${formatTetoActivationCommand("teto-ativar", runtime.defaults.commandPrefix)}`
            });
            if (shouldHint) {
              shared.activationHintAt.set(userId, Date.now());
              await safeSendMessage(remoteJid, {
                text: `oii! ainda não tô ativa aqui no teu PV — manda ${formatTetoActivationCommand("teto-ativar", runtime.defaults.commandPrefix)} que eu começo a responder ✨`
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

        // "fica quieta um minuto" → silêncio de ~1 min já agora (o agente às vezes não chamava calar()).
        if (!isFromMe && !parsedCommand && !isTetosCommand && (!isGroup || isDirect) && detectHushRequest(text)) {
          const applied = runtime.groupEngagement?.muteFromAgent?.(remoteJid, userId, {
            scope: isGroup ? "usuario" : null,
            ttlMs: runtime.defaults.groupMuteMs
          });
          logThinking(runtime, {
            phase: "hush_request",
            userId,
            remoteJid,
            detail: `pedido de silêncio — calar até ${applied?.expiresAt ?? "?"}`
          });
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
              participantJid: incoming.key?.participant ?? null,
              tetosCommandSource: isTetosCommand
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

        // Disponibilidade dela agora (dormindo / ocupada / na rua): guarda e responde depois, como gente.
        const life = runtime.brainOrchestrator?.life;
        life?.tick?.();
        const sleepSnap = life?.sleep?.getSnapshot?.() ?? {};
        const wasTempAwakeBefore = Boolean(life?.tempAwakeFor?.(remoteJid));
        let sleepDisturbedWake = false;

        if (life?.availability && !parsedCommand && !isTetosCommand && !isFromMe && !mainObserveOnly) {
          const flood = trackSleepDisturbanceFlood(sessionId, effectiveMessage);
          const urgency = scoreSleepDisturbance(effectiveMessage, { floodCount: flood.count });
          let avail = life.availability({ chatId: remoteJid, isOwner, urgency });
          if (avail.mode === "asleep" && !isGroup) {
            const woke = life.tryWake({ chatId: remoteJid, score: urgency, floodCount: flood.count, isOwner });
            if (woke) {
              sleepDisturbedWake = true;
              clearSleepDisturbanceFlood(sessionId);
              avail = { ...avail, mode: "online", delayMs: 0 };
              logThinking(runtime, {
                phase: "sleep_disturbed_wake",
                userId,
                remoteJid,
                detail: `acordou com o celular (urgência ${urgency.toFixed(2)}, ${flood.count} msgs)`
              });
            }
          }
          const alreadyHeld = runtime.deferredInbox?.peekCount?.(sessionId) > 0;
          if (avail.delayMs > 0 || alreadyHeld) {
            // Grupo: quem chama no grupo e ela tá dormindo ou demoraria muito… o papo já seguiu.
            const groupTooLate = isGroup && (avail.mode === "asleep" || avail.delayMs > 15 * 60_000);
            if (groupTooLate) {
              finalizeDecisionTrace(runtime, decisionTrace, { pipelineMode: RESPONSE_MODES.SLEEP_HOLD, output: RESPONSE_OUTPUTS.SILENT });
              logThinking(runtime, { phase: "away_skip", userId, remoteJid, detail: `${avail.mode} (${avail.activity}) — não viu a chamada do grupo a tempo` });
              continue;
            }
            const dueAt = Date.now() + Math.max(0, avail.delayMs);
            runtime.deferredInbox?.append?.(
              sessionId,
              {
                message: effectiveMessage,
                userId,
                sessionId,
                remoteJid,
                channelId: remoteJid,
                isGroup,
                isOwner,
                mainObserveOnly,
                participants: (() => {
                  const ch = runtime.channelRegistry.get(remoteJid);
                  if (ch.participants?.length) return ch.participants;
                  return isGroup && participantId ? [participantId] : [userId];
                })(),
                isDirectMention: isGroup ? isDirect : false,
                groupEngagementActive: isGroup ? groupEngagementActive : false,
                groupAddressKind: isGroup ? groupAddressKind : null,
                isReply: isReply || isReplyToBot,
                isReplyToBot,
                quotedMessage,
                quotedMessageId: stanzaId ?? null,
                replyThreadContext,
                media,
                closeDecision: "open",
                messageKey: incoming.key ? { ...incoming.key } : undefined,
                pushName: pushName || null,
                participantId: isGroup ? participantId : null,
                participantJid: isGroup ? participantJid : null
              },
              { dueAt, reason: avail.mode, activity: avail.activity }
            );
            // Insistiu/urgente: ela dá uma olhada antes.
            if (urgency >= 0.7 || (isOwner && flood.count >= 3)) runtime.deferredInbox?.bringForward?.(sessionId, Date.now() + 45_000);
            finalizeDecisionTrace(runtime, decisionTrace, { pipelineMode: RESPONSE_MODES.SLEEP_HOLD, output: RESPONSE_OUTPUTS.SILENT });
            logThinking(runtime, {
              phase: avail.mode === "asleep" ? "sleep_hold" : "away_hold",
              userId,
              remoteJid,
              detail: `${avail.mode} (${avail.activity}) — vê em ~${Math.round((runtime.deferredInbox?.dueAt?.(sessionId) - Date.now()) / 60000)} min (${runtime.deferredInbox?.peekCount?.(sessionId) ?? 0} guardada(s))`
            });
            continue;
          }
        }

        if (wasTempAwakeBefore && !parsedCommand && !isTetosCommand && !isFromMe) {
          life?.extendWake?.(remoteJid);
        }
        if (!isFromMe) runtime.waPresence?.active?.();

        const sleepSnapAfter = life?.sleep?.getSnapshot?.() ?? sleepSnap;

        const mediaOnlyInbound = hasMediaPayload && !String(text ?? "").trim() && !parsedCommand && !isTetosCommand;
        const hasVisionOrTranscript = Boolean(String(media?.transcript ?? "").trim());
        const allowMediaConversation = shouldRespondToMediaOnly({
          media,
          // Áudio no PV sempre merece resposta — nem que seja "não consegui ouvir".
          isDirect: isDirect || (!isGroup && media?.type === "audio"),
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
          caption: String(text ?? "").trim(),
          mediaVisionPromise,
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
      if (!isCurrentHandler()) return;
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
      if (!isCurrentHandler()) return;
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
      if (!isCurrentHandler()) return;
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
