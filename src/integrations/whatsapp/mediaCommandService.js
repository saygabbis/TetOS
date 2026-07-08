import { existsSync, readFileSync } from "node:fs";
import { downloadContentFromMessage } from "baileys";
import { persistMedia } from "./mediaStore.js";
import { resolveCommandTarget } from "./commandTargetResolver.js";
import { isAnimatedRemoveBgTarget } from "../../core/media/mediaProcessor.js";
import { resolveStickerDurationArg } from "../../core/media/stickerDurationParse.js";
import {
  REMOVE_BG_MODEL_LABELS,
  resolveRemoveBgOptions
} from "../../core/media/removeBgOptionsParse.js";
import { UrlDownloadService } from "../../core/media/urlDownloadService.js";
import { convertMedia, normalizeConvertFormat } from "../../core/media/mediaConverter.js";
import { parseUrlDownloadArgs } from "./urlDownloadArgsParse.js";
import { isUrlMediaCommand } from "./mediaCommandParser.js";
import {
  applyQuotedContextToPayload,
  buildOutgoingQuoteKey
} from "./messageContext.js";

function isWaConnectionError(error) {
  const msg = String(error?.message ?? error ?? "");
  return (
    /connection closed/i.test(msg) ||
    error?.output?.statusCode === 428 ||
    error?.output?.payload?.statusCode === 428
  );
}

const PREVIEW_OUTPUT_COMMANDS = new Set([
  "youtube",
  "twitter",
  "instagram",
  "reddit",
  "tiktok",
  "facebook",
  "download",
  "thumbnail",
  "convert"
]);

export class MediaCommandService {
  constructor({
    runtime,
    socket,
    commandQueue,
    mediaHistoryStore,
    mediaProcessor,
    safeSendMessage,
    chatMessageIndex = null,
    logPrefix = "[whatsapp]"
  } = {}) {
    this.runtime = runtime;
    this.socket = socket;
    this.commandQueue = commandQueue;
    this.mediaHistoryStore = mediaHistoryStore;
    this.mediaProcessor = mediaProcessor;
    this._rawSend = safeSendMessage;
    this.safeSendMessage = safeSendMessage;
    this.chatMessageIndex = chatMessageIndex;
    this.logPrefix = logPrefix;
    this._commandQuoteContext = null;
    this.agentMediaInFlight = new Map();
    this.urlDownloader = new UrlDownloadService({
      outputDir: runtime?.defaults?.commandMediaDerivedPath ?? "./data/media/derived",
      ytDlpPath: runtime?.defaults?.ytDlpPath ?? null,
      ytDlpTimeoutMs: runtime?.defaults?.ytDlpTimeoutMs ?? 120000
    });
  }

  appendCommandEvent(event) {
    this.runtime?.eventLedger?.append?.({
      eventType: "command.media",
      ...event
    });
  }

  audit(event) {
    if (!this.runtime?.defaults?.thinkingLogsEnabled) return;
    console.log(`[audit.command] ${JSON.stringify({ ts: new Date().toISOString(), ...event })}`);
  }

  async sendPresence(state, remoteJid) {
    try {
      await this.socket?.sendPresenceUpdate?.(state, remoteJid);
    } catch {
      /* optional */
    }
  }

  buildCommandQuoteKey(remoteJid, incoming) {
    const key = incoming?.key;
    if (!key?.id) return null;
    const participantJid = key.participant ?? incoming?.participant ?? null;
    return buildOutgoingQuoteKey(key, remoteJid, { participantJid });
  }

  async sendCommandReply(remoteJid, incoming, payload) {
    const quoteKey = this.buildCommandQuoteKey(remoteJid, incoming);
    if (!quoteKey) return this._rawSend(remoteJid, payload);
    const indexed = this.chatMessageIndex?.get?.(remoteJid, quoteKey.id) ?? null;
    const full = applyQuotedContextToPayload(payload, quoteKey, indexed);
    return this._rawSend(remoteJid, full);
  }

  async sendWithActiveQuote(remoteJid, payload) {
    const ctx = this._commandQuoteContext;
    if (ctx?.incoming && ctx.remoteJid === remoteJid) {
      return this.sendCommandReply(remoteJid, ctx.incoming, payload);
    }
    return this._rawSend(remoteJid, payload);
  }

  async handle({ incoming, parsedCommand, remoteJid, userId, media }) {
    if (parsedCommand?.command === "gerar") {
      return this.handleGenerateImage({ parsedCommand, remoteJid, userId, incoming });
    }

    if (isUrlMediaCommand(parsedCommand.command)) {
      return this.handleUrlCommand({ parsedCommand, remoteJid, userId, incoming });
    }

    return this.commandQueue.enqueue(remoteJid, async () => {
      this._commandQuoteContext = { remoteJid, incoming };
      const send = (payload) => this.sendWithActiveQuote(remoteJid, payload);
      const prevSend = this.safeSendMessage;
      this.safeSendMessage = send;
      try {
      const startedAt = Date.now();
      const resolved = await resolveCommandTarget({
        incoming,
        remoteJid,
        userId,
        media,
        historyStore: this.mediaHistoryStore,
        persistMedia,
        downloadContentFromMessage,
        basePath: this.runtime.defaults.whatsappMediaPath
      });

      if (!resolved?.media?.path) {
        const hint =
          parsedCommand.command === "convert"
            ? "Nao achei midia valida. Responde (reply) ou anexa a imagem/video/audio e manda o comando, ex.: .convert mp4"
            : "Nao achei midia valida. Manda a imagem/GIF no anexo, responde (reply) a uma midia, ou manda a midia e depois o comando.";
        await this.safeSendMessage(remoteJid, { text: hint });
        this.appendCommandEvent({
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
          const potencyKey = bgOptsEarly.model ?? this.runtime.defaults.removeBgModel ?? "small";
          const potencyLabel = REMOVE_BG_MODEL_LABELS[potencyKey] ?? potencyKey;
          const animTarget = await isAnimatedRemoveBgTarget(resolved.media);
          const statusText = animTarget
            ? "Removendo fundo animado (modelo local - nao gasta creditos remove.bg)... pode demorar bastante."
            : `Removendo fundo (${potencyLabel})...`;
          await this.sendPresence("composing", remoteJid);
          await this.safeSendMessage(remoteJid, { text: statusText });
          await this.sendPresence("paused", remoteJid);
        }
      }

      try {
        const output = await this.processCommand(parsedCommand, resolved, remoteJid);
        if (output === true) return true;

        const skipToimgPlayback =
          parsedCommand.command === "toimg" &&
          output.kind === "video" &&
          output.toimgPlaybackSkipped === true;
        if (!output?.path && !skipToimgPlayback) throw new Error("processing failed");

        await this.sendOutput(parsedCommand, output, remoteJid);

        const elapsedMs = Date.now() - startedAt;
        const okEvent = {
          commandName: parsedCommand.command,
          status: "ok",
          targetSource: resolved.source,
          inputType: resolved.media.type,
          outputType: output.kind,
          remoteJid,
          actorId: userId,
          elapsedMs
        };
        this.audit(okEvent);
        this.appendCommandEvent(okEvent);
        return true;
      } catch (error) {
        if (isWaConnectionError(error)) {
          console.warn(
            `${this.logPrefix} comando ${parsedCommand.command} interrompido - conexao caiu (${remoteJid})`
          );
          return true;
        }
        const failText =
          parsedCommand.command === "removebg"
            ? resolved.media?.type === "sticker"
              ? "Nao consegui remover o fundo dessa figurinha. Estatica: reply + .removebg forte. Animada e instavel - tenta uma figurinha estatica."
              : "Nao consegui remover o fundo desta midia. Imagem/figurinha estatica: .removebg forte. GIF/video animado costuma falhar no modelo local."
            : `Falha ao processar ${parsedCommand.command}: ${error.message}`;
        await this.safeSendMessage(remoteJid, { text: failText });
        const errorEvent = {
          commandName: parsedCommand.command,
          status: "error",
          reason: error.message,
          targetSource: resolved.source,
          inputType: resolved.media?.type ?? null,
          remoteJid,
          actorId: userId
        };
        this.appendCommandEvent(errorEvent);
        this.audit(errorEvent);
        return true;
      }
      } finally {
        this.safeSendMessage = prevSend;
        this._commandQuoteContext = null;
      }
    });
  }

  async handleUrlCommand({ parsedCommand, remoteJid, userId, incoming = null }) {
    return this.commandQueue.enqueue(remoteJid, async () => {
      this._commandQuoteContext = incoming ? { remoteJid, incoming } : null;
      const send = (payload) => this.sendWithActiveQuote(remoteJid, payload);
      const prevSend = this.safeSendMessage;
      this.safeSendMessage = send;
      try {
      const startedAt = Date.now();
      const parsed = parseUrlDownloadArgs(parsedCommand.command, parsedCommand.args);
      if (parsed.error) {
        await this.safeSendMessage(remoteJid, { text: parsed.error });
        this.appendCommandEvent({
          commandName: parsedCommand.command,
          status: "error",
          reason: parsed.error,
          remoteJid,
          actorId: userId
        });
        return true;
      }

      try {
        await this.sendPresence("composing", remoteJid);
        await this.safeSendMessage(remoteJid, { text: "Baixando... pode demorar um pouco." });
        const output = await this.urlDownloader.downloadByCommand(
          parsed.command,
          parsed.url,
          parsed.mode,
          parsed.quality
        );
        await this.sendPresence("paused", remoteJid);
        const outputs = Array.isArray(output?.outputs) ? output.outputs : [output];
        for (const item of outputs) {
          await this.sendMediaOutput(item, remoteJid);
        }

        const okEvent = {
          commandName: parsedCommand.command,
          status: "ok",
          targetSource: "url",
          inputType: "url",
          outputType: output.kind,
          remoteJid,
          actorId: userId,
          elapsedMs: Date.now() - startedAt
        };
        this.audit(okEvent);
        this.appendCommandEvent(okEvent);
        return true;
      } catch (error) {
        await this.sendPresence("paused", remoteJid);
        if (isWaConnectionError(error)) return true;
        const failText =
          "Nao consegui baixar — link privado, expirado ou plataforma bloqueou. Detalhe: " +
          String(error.message ?? error);
        await this.safeSendMessage(remoteJid, { text: failText });
        this.appendCommandEvent({
          commandName: parsedCommand.command,
          status: "error",
          reason: error.message,
          targetSource: "url",
          remoteJid,
          actorId: userId
        });
        return true;
      }
      } finally {
        this.safeSendMessage = prevSend;
        this._commandQuoteContext = null;
      }
    });
  }

  async runUrlDownloadCommand({
    command,
    url,
    args = [],
    remoteJid,
    userId = null
  } = {}) {
    const parsedCommand = {
      command: String(command ?? "").toLowerCase(),
      args: [url, ...(args ?? [])].filter(Boolean)
    };
    return this.handleUrlCommand({ parsedCommand, remoteJid, userId });
  }

  async processCommand(parsedCommand, resolved, remoteJid) {
    const stickerCommands = ["sticker", "fsticker", "csticker"];
    if (stickerCommands.includes(parsedCommand.command)) {
      const durationResolved = resolveStickerDurationArg(parsedCommand.args?.[0]);
      if (durationResolved.error) {
        await this.safeSendMessage(remoteJid, { text: durationResolved.error });
        return true;
      }
      await this.sendPresence("composing", remoteJid);
      const mode =
        parsedCommand.command === "fsticker"
          ? "contain"
          : parsedCommand.command === "csticker"
            ? "crop"
            : "stretch";
      const output = await this.mediaProcessor.toSticker(resolved.media, mode, {
        maxDurationMs: durationResolved.maxDurationMs
      });
      await this.sendPresence("paused", remoteJid);
      return output;
    }

    if (parsedCommand.command === "optimize") {
      if (resolved.media.type !== "sticker") {
        await this.safeSendMessage(remoteJid, {
          text: "O .optimize so funciona com figurinhas. Marque uma figurinha (reply ou anexo) e tente de novo."
        });
        return true;
      }
      await this.sendPresence("composing", remoteJid);
      const output = await this.mediaProcessor.optimizeSticker(resolved.media);
      await this.sendPresence("paused", remoteJid);
      if (output.alreadyOptimized) {
        const kb = Math.round((output.sizeBytes ?? 0) / 1024);
        await this.safeSendMessage(remoteJid, {
          text: `Nao deu pra comprimir mais esta figurinha (${kb} KiB).`
        });
        return true;
      }
      return output;
    }

    if (parsedCommand.command === "removebg") {
      const bgOpts = resolveRemoveBgOptions(parsedCommand.args);
      if (bgOpts.error) {
        await this.safeSendMessage(remoteJid, { text: bgOpts.error });
        return true;
      }
      return this.mediaProcessor.removeBackground(resolved.media, {
        background: bgOpts.background,
        model: bgOpts.model
      });
    }

    if (parsedCommand.command === "toimg") {
      return this.mediaProcessor.toMediaFromSticker(resolved.media);
    }

    if (parsedCommand.command === "convert") {
      const format = normalizeConvertFormat(parsedCommand.args?.[0]);
      if (!format) {
        await this.safeSendMessage(remoteJid, {
          text: "Informe o formato de saida, ex.: .convert mp4 ou .convert png"
        });
        return true;
      }
      await this.sendPresence("composing", remoteJid);
      await this.safeSendMessage(remoteJid, { text: `Convertendo para .${format}...` });
      const output = await convertMedia(
        resolved.media.path,
        format,
        this.runtime.defaults.commandMediaDerivedPath
      );
      await this.sendPresence("paused", remoteJid);
      return output;
    }

    throw new Error(`unsupported media command: ${parsedCommand.command}`);
  }

  async sendOutput(parsedCommand, output, remoteJid) {
    const outBuffer = output.path ? readFileSync(output.path) : null;

    if (parsedCommand.command === "removebg") {
      await this.safeSendMessage(remoteJid, {
        document: outBuffer,
        mimetype: output.mimetype ?? "image/png",
        fileName: output.fileName ?? "sem-fundo.png"
      });
      return;
    }

    if (parsedCommand.command === "toimg") {
      await this.sendToImgOutput(output, outBuffer, remoteJid);
      return;
    }

    if (PREVIEW_OUTPUT_COMMANDS.has(parsedCommand.command)) {
      await this.sendMediaOutput(output, remoteJid);
      return;
    }

    await this.safeSendMessage(remoteJid, { sticker: outBuffer });

    if (
      parsedCommand.command === "optimize" &&
      output.previousSizeBytes &&
      output.sizeBytes &&
      output.sizeBytes < output.previousSizeBytes
    ) {
      const beforeKb = Math.round(output.previousSizeBytes / 1024);
      const afterKb = Math.round(output.sizeBytes / 1024);
      await this.safeSendMessage(remoteJid, {
        text: `Figurinha otimizada: ${beforeKb} KiB -> ${afterKb} KiB. Pode mandar .optimize de novo pra comprimir mais.`
      });
    }
  }

  async sendMediaOutput(output, remoteJid) {
    if (!output?.path || !existsSync(output.path)) return;
    const outBuffer = readFileSync(output.path);
    const mimetype = output.mimetype ?? "application/octet-stream";
    const fileName = output.fileName ?? "arquivo";

    if (output.kind === "video") {
      await this.safeSendMessage(remoteJid, {
        video: outBuffer,
        mimetype,
        gifPlayback: mimetype === "image/gif" || fileName.endsWith(".gif")
      });
    } else if (output.kind === "audio") {
      await this.safeSendMessage(remoteJid, {
        audio: outBuffer,
        mimetype,
        ptt: false
      });
    } else if (output.kind === "image") {
      await this.safeSendMessage(remoteJid, { image: outBuffer, mimetype });
    }

    await this.safeSendMessage(remoteJid, {
      document: outBuffer,
      mimetype,
      fileName
    });
  }

  async runAgentMediaCommand({
    command,
    messageId = null,
    args = [],
    media,
    remoteJid,
    userId = null,
    targetSource = "agent"
  } = {}) {
    const cmd = String(command ?? "").toLowerCase();
    const mid = String(messageId ?? "").trim();
    const dedupeKey = `${remoteJid}:${cmd}:${mid}`;
    if (mid && this.agentMediaInFlight.has(dedupeKey)) {
      return this.agentMediaInFlight.get(dedupeKey);
    }

    const run = this._runAgentMediaCommandOnce({
      command: cmd,
      messageId: mid,
      args,
      media,
      remoteJid,
      userId,
      targetSource
    });
    if (mid) {
      this.agentMediaInFlight.set(dedupeKey, run);
      run.finally(() => this.agentMediaInFlight.delete(dedupeKey));
    }
    return run;
  }

  async _runAgentMediaCommandOnce({
    command: cmd,
    messageId = null,
    args = [],
    media,
    remoteJid,
    userId = null,
    targetSource = "agent"
  } = {}) {
    if (!media?.path) {
      await this.safeSendMessage(remoteJid, {
        text: "Nao achei midia com esse message id. Use o message id (hex 3EB...) da mensagem com imagem, video, GIF ou figurinha no historico."
      });
      return false;
    }
    if (cmd === "toimg" && media.type !== "sticker") {
      await this.safeSendMessage(remoteJid, {
        text: "toimage so funciona com figurinhas — passe o message id de uma sticker."
      });
      return false;
    }

    const parsedCommand = { command: cmd, args: args ?? [] };

    return this.commandQueue.enqueue(remoteJid, async () => {
      const startedAt = Date.now();
      const resolved = { media, source: targetSource };
      try {
        if (cmd === "toimg") {
          await this.sendPresence("composing", remoteJid);
          await this.safeSendMessage(remoteJid, { text: "Convertendo figurinha..." });
        } else if (["sticker", "fsticker", "csticker"].includes(cmd)) {
          await this.sendPresence("composing", remoteJid);
          await this.safeSendMessage(remoteJid, {
            text: "Gerando figurinha... pode demorar um pouco em GIF/video."
          });
        } else if (cmd === "removebg") {
          const bgOptsEarly = resolveRemoveBgOptions(parsedCommand.args);
          if (!bgOptsEarly.error) {
            const potencyKey = bgOptsEarly.model ?? this.runtime.defaults.removeBgModel ?? "small";
            const potencyLabel = REMOVE_BG_MODEL_LABELS[potencyKey] ?? potencyKey;
            const animTarget = await isAnimatedRemoveBgTarget(resolved.media);
            const statusText = animTarget
              ? "Removendo fundo animado (modelo local - nao gasta creditos remove.bg)... pode demorar bastante."
              : `Removendo fundo (${potencyLabel})...`;
            await this.sendPresence("composing", remoteJid);
            await this.safeSendMessage(remoteJid, { text: statusText });
            await this.sendPresence("paused", remoteJid);
          }
        } else if (cmd === "convert") {
          await this.sendPresence("composing", remoteJid);
          await this.safeSendMessage(remoteJid, {
            text: `Convertendo para .${normalizeConvertFormat(parsedCommand.args?.[0]) ?? "?"}...`
          });
        }

        const output = await this.processCommand(parsedCommand, resolved, remoteJid);
        if (output === true) return true;

        const skipToimgPlayback =
          cmd === "toimg" && output.kind === "video" && output.toimgPlaybackSkipped === true;
        if (!output?.path && !skipToimgPlayback) throw new Error("processing failed");

        await this.sendOutput(parsedCommand, output, remoteJid);

        const okEvent = {
          commandName: cmd,
          status: "ok",
          targetSource,
          inputType: media.type,
          outputType: output.kind,
          remoteJid,
          actorId: userId,
          messageId,
          elapsedMs: Date.now() - startedAt
        };
        this.audit(okEvent);
        this.appendCommandEvent(okEvent);
        return true;
      } catch (error) {
        await this.sendPresence("paused", remoteJid);
        if (isWaConnectionError(error)) {
          console.warn(`${this.logPrefix} ${cmd} interrompido - conexao caiu (${remoteJid})`);
          return true;
        }
        const failText =
          cmd === "removebg"
            ? resolved.media?.type === "sticker"
              ? "Nao consegui remover o fundo dessa figurinha. Estatica: removebg forte. Animada e instavel - tenta uma figurinha estatica."
              : "Nao consegui remover o fundo desta midia. Imagem/figurinha estatica: removebg forte. GIF/video animado costuma falhar no modelo local."
            : `Falha ao processar ${cmd}: ${error.message}`;
        await this.safeSendMessage(remoteJid, { text: failText });
        this.appendCommandEvent({
          commandName: cmd,
          status: "error",
          reason: error.message,
          targetSource,
          inputType: media?.type ?? null,
          remoteJid,
          actorId: userId,
          messageId
        });
        return false;
      }
    });
  }

  /** @deprecated use runAgentMediaCommand */
  async runToImageFromMedia(opts = {}) {
    return this.runAgentMediaCommand({ ...opts, command: "toimg" });
  }

  async sendToImgOutput(output, outBuffer, remoteJid) {
    if (output.kind === "video") {
      if (outBuffer) {
        const playbackMime = output.toimgPlaybackMime ?? "video/mp4";
        await this.safeSendMessage(remoteJid, {
          video: outBuffer,
          gifPlayback: true,
          mimetype: playbackMime,
          ...(playbackMime === "video/mp4" && typeof output.toimgPlaybackSeconds === "number"
            ? { seconds: output.toimgPlaybackSeconds }
            : {})
        });
      }
      const gifDoc = output.toimgGifPath;
      if (gifDoc && existsSync(gifDoc)) {
        await this.safeSendMessage(remoteJid, {
          document: readFileSync(gifDoc),
          mimetype: "image/gif",
          fileName: "sticker-convertido.gif"
        });
      }
      return;
    }

    await this.safeSendMessage(remoteJid, { image: outBuffer });
    await this.safeSendMessage(remoteJid, {
      document: outBuffer,
      mimetype: "image/png",
      fileName: "sticker-convertido.png"
    });
  }

  async handleGenerateImage({ parsedCommand, remoteJid, userId, incoming = null }) {
    const prompt = (parsedCommand.args ?? []).join(" ").trim();
    if (!prompt) {
      const prefix = this.runtime?.defaults?.commandPrefix ?? ".";
      await this.safeSendMessage(remoteJid, {
        text: `uso: ${prefix}gerar <descrição da imagem>`
      });
      return true;
    }

    await this.sendPresence("composing", remoteJid);
    const result = await this.runtime?.imageGenerationService?.generate?.({
      prompt,
      userId
    });
    await this.sendPresence("paused", remoteJid);

    if (result?.ok && result.buffer) {
      await this.safeSendMessage(remoteJid, { image: result.buffer });
      this.appendCommandEvent({
        commandName: "gerar",
        status: "ok",
        remoteJid,
        actorId: userId,
        prompt: prompt.slice(0, 120)
      });
      return true;
    }

    await this.safeSendMessage(remoteJid, {
      text: `não consegui gerar: ${result?.error ?? "erro desconhecido"}`
    });
    this.appendCommandEvent({
      commandName: "gerar",
      status: "error",
      remoteJid,
      actorId: userId,
      error: result?.error ?? "unknown"
    });
    return true;
  }
}
