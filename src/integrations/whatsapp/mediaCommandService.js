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

function isWaConnectionError(error) {
  const msg = String(error?.message ?? error ?? "");
  return (
    /connection closed/i.test(msg) ||
    error?.output?.statusCode === 428 ||
    error?.output?.payload?.statusCode === 428
  );
}

export class MediaCommandService {
  constructor({
    runtime,
    socket,
    commandQueue,
    mediaHistoryStore,
    mediaProcessor,
    safeSendMessage,
    logPrefix = "[whatsapp]"
  } = {}) {
    this.runtime = runtime;
    this.socket = socket;
    this.commandQueue = commandQueue;
    this.mediaHistoryStore = mediaHistoryStore;
    this.mediaProcessor = mediaProcessor;
    this.safeSendMessage = safeSendMessage;
    this.logPrefix = logPrefix;
    this.agentMediaInFlight = new Map();
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

  async handle({ incoming, parsedCommand, remoteJid, userId, media }) {
    return this.commandQueue.enqueue(remoteJid, async () => {
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
        await this.safeSendMessage(remoteJid, {
          text: "Nao achei midia valida. Manda a imagem/GIF no anexo, responde (reply) a uma midia, ou manda a midia e depois o comando."
        });
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
    });
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
}
