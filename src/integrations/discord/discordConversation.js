import { existsSync, statSync } from "node:fs";
import { PermissionFlagsBits } from "discord.js";
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
import { DISCORD_UPLOAD_LIMIT, downloadMediaItem, emojiSizedImage, mediaItemsOf } from "./discordMedia.js";
import { formatDuration, parseHushRequest, polishDiscordActions, rateAllows } from "./discordPolicy.js";
import { createDiscordLog } from "./discordLog.js";
import { parseTetosCommand } from "../whatsapp/commands/tetosCommand.js";

/**
 * Conversa no Discord: quando ela responde (modo do canal, marcação, reply, nome, .tetos), quando segura
 * pra depois (dormindo/ocupada/no zap), juntar mensagens seguidas, gerar pelo mesmo pipeline do zap e
 * executar as ações (texto, reação, figurinha, áudio, mídia) com o acabamento do Discord.
 */

// Modo padrão: depois de responder alguém, segue o papo com essa pessoa por esse tempo.
const FOLLOW_MS = 2 * 60_000;
// Figurinha no máximo uma a cada tanto, por canal.
const STICKER_COOLDOWN_MS = 6 * 60_000;
// Dona/moderação dizendo que ela pode voltar a falar.
const RELEASE_RE = /(?<![\p{L}])(?:pode\s+(?:voltar|falar|aparecer)|volta(?:r)?\s+a\s+falar|t[aá]\s+liberada|pode\s+vir)(?![\p{L}])/iu;
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
  const followUntil = new Map(); // "canal:pessoa" → até quando ela segue o papo com essa pessoa
  const lastStickerAt = new Map(); // canal → última figurinha que ela mandou
  const dlog = createDiscordLog({ echo: (line) => log.log?.(line) });
  const clock = (ms) => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  const batches = new Map(); // chave → { entries, timer }
  const running = new Map(); // chave → Promise do turno em andamento
  const seeded = new Set();
  const knownNames = new Map(); // autor → nomes com que já apareceu (apelido no servidor, usuário, nome global)

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
    if (!isFromBot && message?.author?.id) {
      const names = knownNames.get(message.author.id) ?? new Set();
      for (const n of [speakerNameOf(message), message.author.username, message.author.globalName]) if (n) names.add(n);
      knownNames.set(message.author.id, names);
    }
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
    let text = readableContent(message, { botId: botId() });
    const items = mediaItemsOf(message);
    if (!text && !items.length) return;
    const channelId = message.channelId;
    const place = placeLabel(message.channel) ?? `#${channelId}`;
    const who = speakerNameOf(message);
    const mode = isDM ? "padrao" : state.modeOf(channelId);
    record(message, { text: text || (items.length ? `[${items.map((i) => i.name).join(", ")}]` : "") });
    if (isDM || mode !== "off") dlog.chat(place, who, text || `[${items.map((i) => i.name).join(", ")}]`);

    // .tetos <mensagem>: chama ela na hora (igual ao zap), mesmo ocupada; por 30 s as próximas
    // mensagens dessa pessoa nesse canal também (cada uma renova).
    const tetosCmd = parseTetosCommand(text, runtime.defaults.commandPrefix);
    if (tetosCmd) text = tetosCmd.prompt.replace(/^(teto|tetozinha)[,!?.\s]+/i, "").trim() || "oi";
    const summonKey = summonKeyOf(channelId, message.author.id);
    if (tetosCmd) runtime.summons?.summon?.(summonKey);
    const summoned = Boolean(tetosCmd) || Boolean(runtime.summons?.touch?.(summonKey));

    const reply = await isReplyToBot(message);
    const mentioned = addressedToBot(message);
    const nameCalled = !isDM && isNameCall(text);
    const direct = isDM || mentioned || reply.isReplyToBot || nameCalled;
    const canModerate = isOwnerId(message.author.id) || Boolean(message.member?.permissions?.has?.(PermissionFlagsBits.ManageMessages));

    // "fica quieta", "some do discord por 12h": respeita (dona/moderação: o tempo pedido; outros: até 10 min aqui).
    if (direct || summoned) {
      const hush = !tetosCmd ? parseHushRequest(text) : null;
      if (hush) return applyHush(message, hush, { place, who, canModerate });
    }
    const mutedUntil = state.mutedUntil(channelId);
    if (mutedUntil && direct && canModerate && RELEASE_RE.test(text)) {
      state.unmute(channelId, { all: true });
      dlog.decision(place, who, "voltou a falar", "liberaram");
    } else if (mutedUntil && !summoned) {
      if (direct) dlog.decision(place, who, "ficou quieta", `pediram silêncio até ${clock(mutedUntil)}`);
      return;
    }
    if (mode === "off" && !summoned) {
      if (direct) dlog.decision(place, who, "ignorou", "canal desligado — só comando (/perguntar, .tetos)");
      return;
    }

    // Modo padrão: depois que ela responde alguém, segue o papo com essa pessoa por uns minutos.
    const following = !isDM && (followUntil.get(`${channelId}:${message.author.id}`) ?? 0) > Date.now();
    const addressed = direct || summoned || following;
    let freeTurn = false;
    if (mode === "livre") {
      const n = state.countMessage(channelId);
      if (!addressed) {
        if (!rateAllows(n, state.channel(channelId))) return;
        freeTurn = true;
      }
    } else if (!addressed) return;

    const id = identityOf(message.author);
    const entry = {
      channelId,
      guildId: message.guildId ?? null,
      isDM,
      place,
      messageId: message.id,
      authorId: message.author.id,
      userId: id.userId,
      linked: id.linked,
      isOwner: id.isOwner,
      speakerName: who,
      // `message`/`pushName`: campos que a caixa de "pra depois" usa pra juntar a leva.
      pushName: who,
      text,
      message: text,
      mediaItems: items,
      addressed,
      mentioned: mentioned || nameCalled,
      summoned,
      tetosCommand: Boolean(tetosCmd),
      freeTurn,
      isReply: reply.isReply,
      isReplyToBot: reply.isReplyToBot,
      quoted: reply.quoted,
      ts: Date.now()
    };
    if (summoned) {
      // Chamada por comando: vem na hora; o que tinha ficado guardado dessa conversa entra junto.
      const held = inbox.flush(sessionOf(entry));
      if (held) enqueue({ ...held, text: held.message });
    } else if (freeTurn) {
      // Conversa livre só quando ela está disponível de verdade (não guarda pra depois).
      const avail = availabilityFor(entry);
      if (avail.delayMs > 0) {
        dlog.decision(place, who, "não entrou no papo", `${avail.mode}: ${avail.activity}`);
        return;
      }
    } else if (holdIfUnavailable(entry)) return;
    enqueue(entry);
  }

  /** Pedido de silêncio: fica quieta pelo tempo pedido e avisa uma vez, curtinho. */
  async function applyHush(message, hush, { place, who, canModerate }) {
    const ms = canModerate ? hush.ms : Math.min(hush.ms, 10 * 60_000);
    const scope = canModerate ? hush.scope : "channel";
    const until = state.mute(message.channelId, ms, { scope });
    // O que estava guardado/na fila desse canal não sai mais.
    inbox.flush(message.channel?.isDMBased?.() ? `discord-dm:${message.author.id}` : `discord-ch:${message.channelId}`);
    for (const [key, batch] of batches) {
      if (batch.entries.some((e) => e.channelId === message.channelId) || scope === "discord") {
        clearTimeout(batch.timer);
        batches.delete(key);
      }
    }
    const when = ms >= 20 * 3_600_000 ? `<t:${Math.round(until / 1000)}:f>` : `<t:${Math.round(until / 1000)}:t>`;
    const ack = scope === "discord" ? `tá bom, vou sumir do discord até ${when} 🤐` : `tá, fico quieta aqui até ${when} 🤐`;
    dlog.decision(place, who, "ficou quieta", `${scope === "discord" ? "Discord todo" : "este canal"} por ${formatDuration(ms)}${canModerate ? "" : " (limite de quem não modera)"}`);
    await message.reply({ content: ack, allowedMentions: { repliedUser: false } }).catch(() => {});
    dlog.chat(place, "Teto", ack);
  }

  /** O que ela está fazendo e quanto demoraria pra ver (inclui trocar de app se está no zap). */
  function availabilityFor(entry) {
    const life = runtime.brainOrchestrator?.life;
    if (!life?.availability) return { mode: "online", delayMs: 0 };
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
    return { ...avail, urgency };
  }

  /** Dormindo, ocupada ou conversando no zap: guarda e responde quando "pegar o celular". */
  function holdIfUnavailable(entry) {
    const avail = availabilityFor(entry);
    const sessionKey = sessionOf(entry);
    const alreadyHeld = inbox.peekCount(sessionKey) > 0;
    if (avail.delayMs <= 0 && !alreadyHeld) return false;
    // Servidor: se ela só ia ver daqui a muito tempo, o papo já seguiu.
    if (!entry.isDM && (avail.mode === "asleep" || avail.delayMs > 15 * 60_000)) {
      dlog.decision(entry.place, entry.speakerName, "não viu a tempo", `${avail.mode}: ${avail.activity}`);
      return true;
    }
    inbox.append(sessionKey, entry, { dueAt: Date.now() + Math.max(0, avail.delayMs), reason: avail.mode, activity: avail.activity });
    if (avail.urgency >= 0.7) inbox.bringForward(sessionKey, Date.now() + 45_000);
    dlog.decision(entry.place, entry.speakerName, "guardou pra depois", `${avail.mode}: ${avail.activity} — vê em ~${Math.max(1, Math.round((inbox.dueAt(sessionKey) - Date.now()) / 60000))} min`);
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
                groupEngagementActive: !last.isDM && (addressed || last.freeTurn === true),
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
                closeDecision: addressed || last.freeTurn ? "open" : null,
                tetosCommand: last.tetosCommand === true,
                platform: "discord",
                platformPlace: placeLabel(channel),
                platformNote: last.freeTurn
                  ? "Conversa livre: ninguém te chamou, você está entrando no papo do canal como mais uma pessoa do grupo. Comente o assunto do momento em UMA mensagem curta — não responda cada um, não puxe atenção pra você."
                  : null
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

    // Acabamento: uma mensagem só, sem marcar quem ela está respondendo, figurinha rara.
    const replyToNames = [...new Set(entries.flatMap((e) => [e.speakerName, ...namesFor(e.authorId)]))];
    const polished = polishDiscordActions(toRun, {
      replyToNames,
      maxLines: last.isDM ? 3 : 2,
      stickerAllowed: Date.now() - (lastStickerAt.get(last.channelId) ?? 0) > STICKER_COOLDOWN_MS
    });
    if (!polished.length) return;

    if (!last.isDM) {
      for (const e of entries) followUntil.set(`${e.channelId}:${e.authorId}`, Date.now() + FOLLOW_MS);
    }
    const reason = last.tetosCommand ? ".tetos" : extra.deferredCatchUp ? `respondeu o que guardou (${extra.deferredCatchUp.activity ?? extra.deferredCatchUp.reason})` : last.freeTurn ? "conversa livre (ritmo do canal)" : last.isDM ? "DM" : entries.some((e) => e.mentioned) ? "marcaram/chamaram" : entries.some((e) => e.isReplyToBot) ? "reply nela" : "seguindo o papo";
    dlog.decision(last.place ?? placeLabel(channel), last.speakerName, last.freeTurn ? "entrou no papo" : "respondeu", reason);
    // Servidor movimentado: responde a mensagem certa (sem pingar a pessoa).
    const autoReplyTo = !last.isDM && (multi || channel.lastMessageId !== last.messageId) ? last.messageId : null;
    await executeActions(channel, polished, { last, entries, autoReplyTo, chatKey });

    if (!last.isDM) {
      runtime.groupMemory?.append?.({ id: last.messageId, channelId: chatKey, userId: last.userId, speakerName: last.speakerName, text: message, addressedToTeto: addressed, quotedMessageId: last.quoted?.id ?? null });
    }
  }

  /**
   * Nomes com que ela conhece a pessoa: os do Discord + os do zap (vínculo/perfil). A dona é "Gabbis"
   * pra ela, mesmo que no Discord apareça com outro apelido.
   */
  function namesFor(discordId) {
    const names = [...(knownNames.get(discordId) ?? [])];
    if (isOwnerId(discordId)) names.push("Gabbis");
    const { userId, linked } = identityOf({ id: discordId });
    if (linked) {
      const facts = runtime.longTerm?.getProfile?.(userId, "direct")?.facts ?? {};
      names.push(runtime.identityLinks?.get?.(discordId)?.name, facts.preferredName, facts.displayName, facts.name);
    }
    return names.filter(Boolean);
  }

  /** Quem pode ser marcado com @ na resposta: quem falou no canal recentemente. */
  function mentionPeople(channel, chatKey) {
    const rows = index()?.getThread?.(chatKey, 60) ?? [];
    const people = new Map();
    for (const r of rows) {
      if (r.isFromBot || !r.actorId) continue;
      const member = channel.guild?.members?.cache?.get?.(r.actorId);
      people.set(r.actorId, { id: r.actorId, names: [r.speakerName, member?.user?.username, member?.user?.globalName, ...namesFor(r.actorId)].filter(Boolean) });
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
            if (j === 0) dlog.chat(last.place ?? placeLabel(channel), "Teto", text.replace(/<@(\d+)>/g, "@$1"));
          }
          sentTexts.push(action.text);
          replyTo = null;
        } else if (action.type === "react" && action.emoji) {
          const target = await channel.messages.fetch(last.messageId).catch(() => null);
          await target?.react?.(action.emoji).catch(() => {});
          dlog.chat(last.place ?? placeLabel(channel), "Teto", `[reagiu ${action.emoji}]`);
        } else if (action.type === "sticker" && action.key) {
          // Figurinha no tamanho de emoji (48 px), não uma imagem gigante.
          const asset = resolveStickerAsset(action.key, runtime.defaults.stickersPath);
          if (asset?.url) {
            const small = await emojiSizedImage(asset.url, media.emojiDir);
            await sendFile(channel, small.path, `${asset.key}.${small.ext}`, replyTo);
            lastStickerAt.set(last.channelId, Date.now());
            dlog.chat(last.place ?? placeLabel(channel), "Teto", `[figurinha ${asset.key}]`);
          }
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

  return { handleMessage, deliverDue, say, record, identityOf, isOwnerId, summonKeyOf, namesFor, dlog };
}
