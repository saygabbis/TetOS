import { existsSync, statSync } from "node:fs";
import { handleIncomingMessage } from "../../app/createRuntime.js";
import { withGenerationSlot } from "../../infra/concurrency/generationSlot.js";
import { resolveOutgoingActions, sanitizeOutgoingActions } from "../../modules/chat/chatService.js";
import { recentAssistantTurns, regulateMessageActions } from "../../modules/chat/styleRegulator.js";
import { formatMediaInputText } from "../../core/channels/mediaTimelineEnrich.js";
import { enrichMediaVision } from "../../modules/vision/mediaVisionEnrich.js";
import { scoreSleepDisturbance } from "../../core/life/sleepDisturbanceDetect.js";
import { platformLabel } from "../../core/presence/attentionFocus.js";
import { resolveOwnerActorId } from "../../core/channels/userActivity.js";
import { resolveDiscordUserId } from "../../core/identity/identityLinks.js";
import { resolveStickerAsset } from "../whatsapp/media/stickerAssets.js";
import { saveStickerToRepertoireWithVision } from "../whatsapp/media/stickerRepertoire.js";
import { detectTetoNameCall } from "../whatsapp/inbound/tetoNameDetect.js";
import { applyOutgoingMentions, placeLabel, readableContent, speakerNameOf, splitForDiscord } from "./discordText.js";
import { DISCORD_UPLOAD_LIMIT, downloadMediaItem, mediaItemsOf } from "./discordMedia.js";

/**
 * Conversa no Discord: quando ela responde (marcada, reply, chamada pelo nome, ou "conversa livre"
 * ligada no canal), quando segura pra depois (dormindo/ocupada/no zap), juntar mensagens seguidas,
 * gerar pelo mesmo pipeline do zap e executar as ações (texto, reação, figurinha, áudio, mídia).
 */

const ENGAGEMENT_MS = 2 * 60_000;
const FREE_CHAT_CHANCE = 0.3;
const FREE_CHAT_COOLDOWN_MS = 90_000;
const DM_BATCH_MS = 1500;
const GUILD_BATCH_MS = 2400;
const MODEL_TIMEOUT_MS = Number(process.env.TETOS_MODEL_TIMEOUT_MS ?? 25000) * 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));

/** Chamaram pelo nome ("teto, ...", "né teto?") — no servidor isso conta como chamar ela. */
export function isNameCall(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  // Só os jeitos inconfundíveis ("kasane teto", "tetooo", "tetozinha"); "o teto da sala" não é ela.
  if (["kasane_teto", "stretched_teto", "tetozinha"].includes(detectTetoNameCall(t).variant)) return true;
  return /^(?:(?:oi+e*|ei+|ow+|eae|e a[ií]|fala|bom dia|boa (?:tarde|noite))[\s,!]+)?(?:kasane\s+)?teto\b[\s,!?:]/i.test(`${t} `) ||
    /[\s,]teto\s*[?!.]*\s*$/i.test(t);
}

export function createDiscordConversation({ runtime, client, state, media, inbox, log = console }) {
  const engagedUntil = new Map(); // canal → até quando o papo com ela está "quente"
  const lastFreeReply = new Map(); // canal → última vez que entrou no papo sem ser chamada
  const batches = new Map(); // chave → { entries, timer }
  const running = new Map(); // chave → Promise do turno em andamento
  const seeded = new Set();

  const botId = () => client.user?.id ?? null;
  const index = () => runtime.chatMessageIndex ?? null;
  const keyOf = (channelId) => `discord:${channelId}`;
  const isOwnerId = (id) => (runtime.defaults.ownerDiscordIds ?? []).includes(String(id));

  function identityOf(user) {
    const isOwner = isOwnerId(user.id);
    const { userId, linked } = resolveDiscordUserId(runtime.identityLinks, user.id, {
      isOwner,
      ownerFallbackUserId: resolveOwnerActorId(runtime)
    });
    return { userId, linked, isOwner };
  }

  function record(message, { text = null, isFromBot = false } = {}) {
    const idx = index();
    if (!idx || !message?.id) return;
    idx.append({
      channelId: keyOf(message.channelId),
      messageId: message.id,
      actorId: isFromBot ? "teto" : message.author?.id,
      speakerName: isFromBot ? "Teto" : speakerNameOf(message),
      text: text ?? readableContent(message, { botId: botId() }) ?? "",
      isFromBot,
      quotedMessageId: message.reference?.messageId ?? null,
      ts: new Date(message.createdTimestamp ?? Date.now()).toISOString()
    });
  }

  /** 1ª vez num canal depois de ligar: puxa as últimas mensagens pra ela ter o contexto. */
  async function seedHistory(channel) {
    if (seeded.has(channel.id)) return;
    seeded.add(channel.id);
    try {
      const recent = await channel.messages.fetch({ limit: 15 });
      for (const m of [...recent.values()].reverse()) record(m, { isFromBot: m.author?.id === botId() });
    } catch {
      /* sem permissão de histórico: segue só com o que viu */
    }
  }

  async function isReplyToBot(message) {
    if (!message.reference?.messageId) return { isReply: false, isReplyToBot: false, quoted: null };
    try {
      const ref = await message.fetchReference();
      return {
        isReply: true,
        isReplyToBot: ref.author?.id === botId(),
        quoted: { id: ref.id, text: readableContent(ref, { botId: botId() }) || (ref.attachments.size ? "[anexo]" : ""), author: speakerNameOf(ref) }
      };
    } catch {
      return { isReply: true, isReplyToBot: false, quoted: null };
    }
  }

  function addressedToBot(message) {
    const id = botId();
    if (!id) return false;
    if (message.mentions?.has?.(id, { ignoreEveryone: true, ignoreRepliedUser: true, ignoreRoles: true })) return true;
    // Marcaram o cargo dela (todo bot tem um cargo com o nome dele).
    const botRole = message.guild?.members?.me?.roles?.botRole;
    return Boolean(botRole && message.mentions?.roles?.has?.(botRole.id));
  }

  /** Entrada de uma mensagem do Discord (texto já tratado; mídia baixa só na hora de responder). */
  async function handleMessage(message) {
    if (message.author?.bot || message.system || message.webhookId) return;
    const isDM = message.channel?.isDMBased?.() ?? !message.guildId;
    const text = readableContent(message, { botId: botId() });
    const items = mediaItemsOf(message);
    if (!text && !items.length) return;
    record(message, { text: text || (items.length ? `[${items.map((i) => i.name).join(", ")}]` : "") });

    const channelId = message.channelId;
    if (!isDM && state.mutedUntil(channelId)) return;

    const reply = await isReplyToBot(message);
    const mentioned = addressedToBot(message);
    const nameCalled = !isDM && isNameCall(text);
    // Marcar ela (ou dar reply nela) chama na hora, mesmo ocupada; por 30 s as próximas mensagens
    // dessa pessoa nesse canal também contam como chamada (cada uma renova).
    const summonKey = summonKeyOf(channelId, message.author.id);
    if (mentioned || reply.isReplyToBot) runtime.summons?.summon?.(summonKey);
    const summoned = mentioned || reply.isReplyToBot || Boolean(runtime.summons?.touch?.(summonKey));
    const addressed = isDM || summoned || nameCalled;
    const engaged = !isDM && (engagedUntil.get(channelId) ?? 0) > Date.now();
    const freeChat = !isDM && state.isFreeChat(channelId);

    if (!addressed) {
      if (!freeChat) return;
      // Conversa livre: entra no papo quando ele está "quente" com ela, ou de vez em quando.
      const cooled = Date.now() - (lastFreeReply.get(channelId) ?? 0) > FREE_CHAT_COOLDOWN_MS;
      if (!engaged && !(cooled && Math.random() < FREE_CHAT_CHANCE && text.length >= 6)) return;
    }

    const who = identityOf(message.author);
    const entry = {
      channelId,
      guildId: message.guildId ?? null,
      isDM,
      messageId: message.id,
      authorId: message.author.id,
      userId: who.userId,
      linked: who.linked,
      isOwner: who.isOwner,
      speakerName: speakerNameOf(message),
      // `message`/`pushName`: campos que a caixa de "pra depois" usa pra juntar a leva.
      pushName: speakerNameOf(message),
      text,
      message: text,
      mediaItems: items,
      addressed,
      mentioned: mentioned || nameCalled,
      summoned,
      engaged,
      isReply: reply.isReply,
      isReplyToBot: reply.isReplyToBot,
      quoted: reply.quoted,
      ts: Date.now()
    };
    if (summoned) {
      // Veio na hora: o que tinha ficado guardado dessa conversa entra junto.
      const held = inbox.flush(sessionOf(entry));
      if (held) enqueue({ ...held, text: held.message });
    } else if (holdIfUnavailable(entry)) return;
    enqueue(entry);
  }

  /** Dormindo, ocupada ou conversando no zap: guarda e responde quando "pegar o celular". */
  function holdIfUnavailable(entry) {
    const life = runtime.brainOrchestrator?.life;
    if (!life?.availability) return false;
    life.tick?.();
    const sessionKey = sessionOf(entry);
    const urgency = scoreSleepDisturbance(entry.text, { floodCount: inbox.peekCount(sessionKey) });
    const chatKey = keyOf(entry.channelId);
    let avail = life.availability({ chatId: chatKey, isOwner: entry.isOwner, urgency });
    if (avail.mode === "asleep" && entry.isDM) {
      const woke = life.tryWake({ chatId: chatKey, score: urgency, floodCount: inbox.peekCount(sessionKey) + 1, isOwner: entry.isOwner });
      if (woke) avail = { ...avail, mode: "online", delayMs: 0 };
    }
    const switchMs = avail.mode === "asleep" ? 0 : runtime.attention?.switchDelayMs?.("discord", { isOwner: entry.isOwner }) ?? 0;
    if (switchMs > avail.delayMs) {
      const from = runtime.attention.active();
      avail = { ...avail, mode: "other_app", activity: `conversando no ${platformLabel(from?.platform)}`, delayMs: switchMs };
    }
    const alreadyHeld = inbox.peekCount(sessionKey) > 0;
    if (avail.delayMs <= 0 && !alreadyHeld) return false;
    // Servidor: se ela só ia ver daqui a muito tempo, o papo já seguiu.
    if (!entry.isDM && (avail.mode === "asleep" || avail.delayMs > 15 * 60_000)) {
      log.log?.(`[discord] não viu a tempo (${avail.mode}: ${avail.activity}) — #${entry.channelId}`);
      return true;
    }
    inbox.append(sessionKey, entry, { dueAt: Date.now() + Math.max(0, avail.delayMs), reason: avail.mode, activity: avail.activity });
    if (urgency >= 0.7) inbox.bringForward(sessionKey, Date.now() + 45_000);
    log.log?.(`[discord] guardou pra depois (${avail.mode}: ${avail.activity}) — vê em ~${Math.round((inbox.dueAt(sessionKey) - Date.now()) / 60000)} min`);
    return true;
  }

  const summonKeyOf = (channelId, authorId) => `discord:${channelId}:${authorId}`;
  const sessionOf = (entry) => (entry.isDM ? `discord-dm:${entry.authorId}` : `discord-ch:${entry.channelId}`);

  function enqueue(entry) {
    const key = sessionOf(entry);
    const batch = batches.get(key) ?? { entries: [] };
    batch.entries.push(entry);
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      batches.delete(key);
      runTurn(key, batch.entries).catch((error) => log.error?.(`[discord] turno falhou: ${error?.stack ?? error}`));
    }, entry.isDM ? DM_BATCH_MS : GUILD_BATCH_MS);
    batches.set(key, batch);
  }

  /** Um turno por conversa de cada vez; o que chega no meio vira o próximo turno. */
  async function runTurn(key, entries, extra = {}) {
    const prev = running.get(key) ?? Promise.resolve();
    const job = prev.then(() => respond(entries, extra)).catch((error) => log.error?.(`[discord] resposta falhou: ${error?.stack ?? error}`));
    running.set(key, job);
    await job;
    if (running.get(key) === job) running.delete(key);
  }

  /** Mensagens guardadas cuja hora chegou. */
  function deliverDue() {
    for (const caught of inbox.drainDue()) {
      const key = sessionOf(caught);
      runTurn(key, [{ ...caught, text: caught.message }], {
        deferredCatchUp: caught.deferredCatchUp,
        sleepCatchUp: caught.sleepCatchUp === true,
        batchedCount: caught.batchedCount ?? 1
      }).catch(() => {});
    }
  }

  async function prepareMedia(entry) {
    const item = entry.mediaItems?.[0];
    if (!item) return null;
    try {
      const file = await downloadMediaItem(item, media.inboxDir);
      if (file.type === "audio") {
        const r = await runtime.audioTranscriber?.transcribe?.({ filePath: file.path, mimetype: file.mimetype ?? "audio/ogg" });
        return { ...file, transcript: r?.text ?? null, transcriptSource: r?.source ?? null };
      }
      if (["image", "gif", "video"].includes(file.type) && runtime.defaults.visionEnabled !== false) {
        const desc = await enrichMediaVision(runtime, { filePath: file.path, mediaType: file.type, isAnimated: file.isAnimated }).catch(() => null);
        return { ...file, transcript: desc ?? null, visionAttempted: true, visionStatus: desc ? "ok" : "failed" };
      }
      return file;
    } catch (error) {
      log.warn?.(`[discord] mídia não baixou: ${error?.message ?? error}`);
      return null;
    }
  }

  async function respond(entries, extra = {}) {
    const last = entries[entries.length - 1];
    const channel = await client.channels.fetch(last.channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    await seedHistory(channel);

    const mediaEntry = [...entries].reverse().find((e) => e.mediaItems?.length);
    const mediaObj = mediaEntry ? await prepareMedia(mediaEntry) : null;
    const speakers = [...new Set(entries.map((e) => e.authorId))];
    const multi = !last.isDM && speakers.length > 1;
    const textOf = (e) => (e === mediaEntry && mediaObj ? formatMediaInputText({ text: e.text, media: mediaObj }) : e.text || "[anexo]");
    const message = multi ? entries.map((e) => `[${e.speakerName}]: ${textOf(e)}`).join("\n") : entries.map(textOf).join("\n");
    if (mediaEntry && mediaObj) index()?.append?.({ channelId: keyOf(mediaEntry.channelId), messageId: mediaEntry.messageId, actorId: mediaEntry.authorId, speakerName: mediaEntry.speakerName, text: textOf(mediaEntry) });

    const chatKey = keyOf(last.channelId);
    const sessionId = last.isDM ? `discord-dm:${last.authorId}` : `discord-ch:${last.channelId}:${last.authorId}`;
    const participants = [...new Set((index()?.getThread?.(chatKey, 40) ?? []).filter((r) => !r.isFromBot).map((r) => r.actorId))];
    const addressed = entries.some((e) => e.addressed);

    // Estilo (abertura repetida, CAPS…) compara com o que ela mandou ANTES deste turno.
    const styleSession = last.isDM ? sessionId : `wa-group-channel:${chatKey}`;
    const styleMark = runtime.shortTerm?.mark?.(styleSession) ?? null;

    let typing = true;
    const typingLoop = (async () => {
      while (typing) {
        await channel.sendTyping().catch(() => {});
        await sleep(8000);
      }
    })();

    let out = null;
    try {
      for (let attempt = 0; attempt < 2 && !out; attempt += 1) {
        try {
          out = await Promise.race([
            withGenerationSlot(() =>
              handleIncomingMessage(runtime, {
                message,
                userId: last.userId,
                sessionId,
                channelId: chatKey,
                isGroup: !last.isDM,
                participants: participants.length ? participants : [last.userId],
                isDirectMention: !last.isDM && entries.some((e) => e.mentioned),
                groupEngagementActive: !last.isDM && (entries.some((e) => e.engaged) || addressed),
                isReply: entries.some((e) => e.isReply),
                isReplyToBot: entries.some((e) => e.isReplyToBot),
                quotedMessage: last.quoted?.text ?? null,
                quotedMessageId: last.quoted?.id ?? null,
                messageKey: { id: last.messageId, remoteJid: chatKey, fromMe: false },
                messageId: last.messageId,
                media: mediaObj,
                pushName: last.speakerName,
                participantId: last.isDM ? null : last.userId,
                segmentSpeakers: multi ? [...new Set(entries.map((e) => e.speakerName))] : null,
                segmentMultiSpeaker: multi,
                segmentParts: multi ? entries.map((e) => ({ userId: e.userId, speakerName: e.speakerName, message: textOf(e) })) : null,
                isOwner: !multi && last.isOwner,
                batchedCount: extra.batchedCount ?? entries.length,
                sleepCatchUp: extra.sleepCatchUp === true,
                deferredCatchUp: extra.deferredCatchUp ?? null,
                closeDecision: addressed ? "open" : null,
                platform: "discord",
                platformPlace: placeLabel(channel)
              })
            ),
            new Promise((_, reject) => setTimeout(() => reject(new Error("model timeout")), MODEL_TIMEOUT_MS))
          ]);
        } catch (error) {
          if (attempt === 1) log.error?.(`[discord] geração falhou: ${error?.message ?? error}`);
        }
      }
    } finally {
      typing = false;
    }
    await typingLoop.catch(() => {});

    let replies = out?.replies ?? [];
    const actions = Array.isArray(replies.actions) ? replies.actions : replies.map((text) => ({ type: "message", text, quoteId: null }));
    if (!actions.length) {
      if (addressed && !out) await channel.send("eita, travei aqui... manda de novo daqui a pouco").catch(() => {});
      return;
    }
    const historyNow = runtime.shortTerm?.getAll?.(styleSession) ?? [];
    const markAt = styleMark ? historyNow.indexOf(styleMark) : -1;
    const regulated = regulateMessageActions(resolveOutgoingActions(actions), {
      isGroup: !last.isDM,
      dropIfAllRepeated: !last.isDM,
      recentTurns: recentAssistantTurns(markAt >= 0 ? historyNow.slice(0, markAt + 1) : [])
    });
    const toRun = resolveOutgoingActions(sanitizeOutgoingActions(regulated, { messageKey: { id: last.messageId }, quotedMessageId: last.quoted?.id ?? null, isReply: last.isReply }));

    if (!last.isDM) {
      engagedUntil.set(last.channelId, Date.now() + ENGAGEMENT_MS);
      if (!addressed) lastFreeReply.set(last.channelId, Date.now());
    }
    // Servidor movimentado: a 1ª bolha responde a mensagem certa (sem pingar a pessoa).
    const autoReplyTo = !last.isDM && (multi || channel.lastMessageId !== last.messageId) ? last.messageId : null;
    await executeActions(channel, toRun, { last, entries, autoReplyTo, chatKey });

    if (!last.isDM) {
      runtime.groupMemory?.append?.({ id: last.messageId, channelId: chatKey, userId: last.userId, speakerName: last.speakerName, text: message, addressedToTeto: addressed, quotedMessageId: last.quoted?.id ?? null });
    }
  }

  /** Quem pode ser marcado com @ na resposta: quem falou no canal recentemente. */
  function mentionPeople(channel, chatKey) {
    const rows = index()?.getThread?.(chatKey, 60) ?? [];
    const people = new Map();
    for (const r of rows) {
      if (r.isFromBot || !r.actorId) continue;
      const member = channel.guild?.members?.cache?.get?.(r.actorId);
      people.set(r.actorId, { id: r.actorId, names: [r.speakerName, member?.user?.username, member?.user?.globalName].filter(Boolean) });
    }
    return [...people.values()];
  }

  async function sendFile(channel, path, name, replyTo = null) {
    if (!path || !existsSync(path)) throw new Error("arquivo não existe");
    if (statSync(path).size > DISCORD_UPLOAD_LIMIT) {
      return channel.send({ content: "ficou grande demais pro discord deixar eu mandar 😭", ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}) });
    }
    return channel.send({ files: [{ attachment: path, name }], ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}), allowedMentions: { repliedUser: false } });
  }

  async function mediaFromMessageId(channel, messageId) {
    const target = await channel.messages.fetch(String(messageId)).catch(() => null);
    const item = target ? mediaItemsOf(target)[0] : null;
    return item ? downloadMediaItem(item, media.inboxDir) : null;
  }

  async function executeActions(channel, actions, { last, autoReplyTo, chatKey }) {
    let replyTo = autoReplyTo;
    const people = mentionPeople(channel, chatKey);
    const sentTexts = [];
    for (const [i, action] of actions.entries()) {
      if (i > 0) await sleep(between(700, 1400));
      try {
        if (action.type === "message" && action.text) {
          const ref = action.quoteId && /^\d{15,}$/.test(String(action.quoteId)) ? String(action.quoteId) : replyTo;
          const { text, userIds } = applyOutgoingMentions(action.text, people);
          for (const [j, part] of splitForDiscord(text).entries()) {
            const sent = await channel.send({
              content: part,
              ...(ref && j === 0 ? { reply: { messageReference: ref, failIfNotExists: false } } : {}),
              allowedMentions: { parse: [], users: userIds, repliedUser: false }
            });
            record(sent, { text: action.text, isFromBot: true });
          }
          sentTexts.push(action.text);
          replyTo = null;
        } else if (action.type === "react" && action.emoji) {
          const target = await channel.messages.fetch(last.messageId).catch(() => null);
          await target?.react?.(action.emoji).catch(() => {});
        } else if (action.type === "sticker" && action.key) {
          const asset = resolveStickerAsset(action.key, runtime.defaults.stickersPath);
          if (asset?.url) await sendFile(channel, asset.url, `${asset.key}.webp`, replyTo);
          replyTo = null;
        } else if (action.type === "voice" && action.text) {
          const requested = /(?<!\p{L})([aá]udio|voz|fala comigo|grava)(?!\p{L})/iu.test(last.text ?? "");
          const voice = runtime.voiceNotes;
          if (voice?.canSend(chatKey, { requested }) && (last.isDM || requested)) {
            const note = await voice.synthesize(action.text);
            await channel.send({ files: [{ attachment: note.audio, name: "teto.ogg" }], allowedMentions: { repliedUser: false } });
            voice.markSent(chatKey);
          } else {
            await channel.send({ content: action.text, allowedMentions: { parse: [] } });
          }
        } else if (action.type === "generate_image" && action.prompt) {
          const result = await media.run("gerar", [action.prompt], { userId: last.userId });
          if (result.files?.length) await sendFile(channel, result.files[0].path, result.files[0].name);
          else if (result.error) await channel.send(result.error);
        } else if (action.type === "url_download" && action.url) {
          const result = await media.run(action.command, [action.url, ...(action.args ?? [])], { userId: last.userId });
          for (const f of result.files ?? []) await sendFile(channel, f.path, f.name);
          if (result.error) await channel.send(result.error);
        } else if ((action.type === "media" || action.type === "toimage") && action.messageId) {
          const input = await mediaFromMessageId(channel, action.messageId);
          const result = await media.run(action.command ?? "toimg", action.args ?? [], { input, userId: last.userId });
          for (const f of result.files ?? []) await sendFile(channel, f.path, f.name);
          if (result.error || result.text) await channel.send(result.error ?? result.text);
        } else if (action.type === "save_sticker" && action.messageId) {
          const input = await mediaFromMessageId(channel, action.messageId);
          if (!input) {
            await channel.send("não achei imagem nessa mensagem pra salvar");
            continue;
          }
          const sticker = await media.processor.toSticker(input, "contain");
          const saved = await saveStickerToRepertoireWithVision({
            runtime,
            sourcePath: sticker.path,
            basePath: runtime.defaults.stickersPath,
            key: action.key,
            messageId: action.messageId,
            savedFrom: chatKey,
            media: { ...input, type: "sticker", path: sticker.path },
            userId: last.userId,
            remoteJid: chatKey,
            skipVision: Boolean(action.key)
          });
          if (!sentTexts.length) await channel.send(`salvei como "${String(saved.key ?? "figurinha").replace(/[-_]+/g, " ")}" kkk`);
        } else if (action.type === "repertoire_mode") {
          const store = runtime.stickerRepertoireMode;
          if (action.enabled) store?.enable?.(last.userId, { source: "discord" });
          else store?.disable?.(last.userId);
        } else if (action.type === "silence") {
          if (!last.isDM) state.mute(last.channelId, 60_000);
        }
      } catch (error) {
        log.warn?.(`[discord] ação ${action.type} falhou: ${error?.message ?? error}`);
      }
    }
  }

  /** Mensagem solta dela num canal (lembrete, aviso). */
  async function say(channelId, text) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) throw new Error("canal não encontrado");
    for (const part of splitForDiscord(text)) {
      const sent = await channel.send({ content: part, allowedMentions: { parse: [] } });
      record(sent, { text: part, isFromBot: true });
    }
  }

  return { handleMessage, deliverDue, say, record, identityOf, isOwnerId, summonKeyOf };
}
