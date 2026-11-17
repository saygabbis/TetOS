import { existsSync, readFileSync } from "node:fs";
import { downloadContentFromMessage } from "baileys";
import { persistMedia } from "../media/mediaStore.js";
import { resolveCommandTarget } from "./commandTargetResolver.js";
import { isAnimatedRemoveBgTarget } from "../../../core/media/mediaProcessor.js";
import { resolveStickerDurationArg } from "../../../core/media/stickerDurationParse.js";
import {
  REMOVE_BG_MODEL_LABELS,
  resolveRemoveBgOptions
} from "../../../core/media/removeBgOptionsParse.js";
import { UrlDownloadService } from "../../../core/media/urlDownloadService.js";
import { convertMedia, normalizeConvertFormat } from "../../../core/media/mediaConverter.js";
import { parseUrlDownloadArgs } from "./urlDownloadArgsParse.js";
import { isUrlMediaCommand, formatMissingMediaCommandHint } from "./mediaCommandParser.js";
import {
  applyQuotedContextToPayload,
  buildOutgoingQuoteKey
} from "../inbound/messageContext.js";
import {
  buildWaDocumentPayload,
  buildWaGifPlaybackPayload,
  buildWaMediaPayload
} from "../media/waMediaPayload.js";

function isWaConnectionError(error) {
  const msg = String(error?.message ?? error ?? "");
  return (
    /connection closed/i.test(msg) ||
    error?.output?.statusCode === 428 ||
    error?.output?.payload?.statusCode === 428
  );
}

const MIME_BY_EXT = {
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac", aac: "audio/aac",
  mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime", avi: "video/x-msvideo",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  avif: "image/avif", ico: "image/x-icon", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain",
  srt: "application/x-subrip", vtt: "text/vtt", zip: "application/zip"
};
const KIND_BY_PREFIX = { audio: "audio", video: "video", image: "image" };

/** Saída de arquivo (Convenus) no formato que o envio espera. */
function fileOutput(path, fallbackName, extra = {}) {
  const ext = String(path ?? "").split(".").pop().toLowerCase();
  const mimetype = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const kind = ext === "gif" || ext === "svg" ? "document" : KIND_BY_PREFIX[mimetype.split("/")[0]] ?? "document";
  const base = String(path ?? "").split(/[\\/]/).pop() || fallbackName;
  return { path, kind, mimetype, fileName: base, ...extra };
}

function mediaLabel(media = {}) {
  const map = { image: "imagem", video: "vídeo", gif: "gif", sticker: "figurinha", audio: "áudio", ptt: "áudio", voice: "áudio", document: "arquivo" };
  return map[media.type] ?? "arquivo";
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

const MODE_LABEL = { mp3: "áudio MP3", wav: "áudio WAV", mp4: "vídeo", srt: "legenda", post: "mídia", user: "foto de perfil", banner: "capa do perfil" };

function qualityLabel(parsed) {
  const q = String(parsed?.quality ?? "full");
  if (/^\d+$/.test(q)) return Number(q) >= 100 && Number(q) <= 320 && parsed.mode === "mp3" ? `${q} kbps` : `${q}p`;
  return { full: "melhor qualidade", mid: "qualidade média", low: "qualidade baixa" }[q] ?? q;
}

/** Confirmação do que vai ser feito, antes de começar. */
export function describeDownloadStart(parsed, meta = null) {
  const what =
    parsed.command === "thumbnail" ? "a capa" :
    parsed.command === "legenda" ? `a legenda${parsed.lang ? ` (${parsed.lang})` : ""}` :
    `${MODE_LABEL[parsed.mode] ?? "mídia"}${parsed.command === "thumbnail" || parsed.mode === "srt" ? "" : ` · ${qualityLabel(parsed)}`}`;
  const title = meta?.title ? `\n🎬 *${String(meta.title).slice(0, 90)}*${meta.duration ? ` (${fmtDuration(meta.duration)})` : ""}` : "";
  const note = parsed.platformNote ? `\n(${parsed.platformNote})` : "";
  return `⬇️ baixando ${what}${meta?.platform ? ` do ${meta.platform}` : ""}…${title}${note}`;
}

/** Legenda do arquivo entregue (confirma o que saiu). */
export function describeDownloadDone(outputs = [], parsed = {}) {
  const first = outputs[0] ?? {};
  const total = outputs.reduce((sum, o) => sum + (Number(o?.sizeBytes) || 0), 0);
  const parts = [
    parsed.title ? `*${String(parsed.title).slice(0, 90)}*` : null,
    [
      outputs.length > 1 ? `${outputs.length} arquivos` : (first.fileName?.split(".").pop() ?? "").toUpperCase() || null,
      total ? fmtSize(total) : null,
      first.subLang ? `legenda ${first.subLang}` : null
    ].filter(Boolean).join(" · ")
  ].filter(Boolean);
  return `✅ ${parts.join("\n")}`.trim();
}

/** Erro técnico → frase que dá pra entender. */
export function friendlyDownloadError(error) {
  const msg = String(error?.message ?? error ?? "");
  if (/private|privad|login|sign in|cookies|age/i.test(msg)) return "o conteúdo é privado ou pede login 🔒";
  if (/unsupported url|não suportad|nao suportad|no video|sem v[ií]deo|nothing to download/i.test(msg)) return "não achei mídia nesse link";
  if (/legenda|subtitle|subs/i.test(msg)) return msg.length < 160 ? msg : "esse vídeo não tem legenda";
  if (/too large|grande demais|max.?size|413/i.test(msg)) return "o arquivo é grande demais pro zap";
  if (/timeout|timed out|demorou/i.test(msg)) return "demorou demais, tenta de novo ou pede qualidade menor (ex.: 480)";
  if (/404|not found|unavailable|indispon/i.test(msg)) return "o link não existe mais ou tá indisponível";
  if (/conversor indispon|unreachable|ECONNREFUSED|fetch failed/i.test(msg)) return "o conversor tá fora do ar agora, tenta daqui a pouco";
  return msg.length > 0 && msg.length < 160 ? msg : "deu um erro no download, tenta de novo";
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
      ytDlpTimeoutMs: runtime?.defaults?.ytDlpTimeoutMs ?? 120000,
      convenus: runtime?.convenus ?? null
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
      const send = (arg1, arg2) => {
        const payload = arg2 !== undefined ? arg2 : arg1;
        return this.sendWithActiveQuote(remoteJid, payload);
      };
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
        const hint = formatMissingMediaCommandHint(
          parsedCommand.command,
          this.runtime.defaults.commandPrefix
        );
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
      const send = (arg1, arg2) => {
        const payload = arg2 !== undefined ? arg2 : arg1;
        return this.sendWithActiveQuote(remoteJid, payload);
      };
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
        if (parsed.command === "linkinfo") {
          await this.safeSendMessage(remoteJid, { text: await this.describeLink(parsed.url) });
          await this.sendPresence("paused", remoteJid);
          return true;
        }
        const meta = await this.runtime?.convenus?.info?.(parsed.url).catch(() => null);
        await this.safeSendMessage(remoteJid, { text: describeDownloadStart(parsed, meta) });
        const output =
          parsed.command === "legenda"
            ? await this.urlDownloader.downloadSubtitles(parsed.url, parsed.lang)
            : parsed.command === "mp3"
              ? await this.urlDownloader.downloadAudio(parsed.url, parsed.quality)
              : await this.urlDownloader.downloadByCommand(parsed.command, parsed.url, parsed.mode, parsed.quality);
        await this.sendPresence("paused", remoteJid);
        const outputs = Array.isArray(output?.outputs) ? output.outputs : [output];
        for (const [i, item] of outputs.entries()) {
          const caption = i === 0 ? describeDownloadDone(outputs, { ...parsed, title: meta?.title ?? item.title }) : null;
          await this.sendDownloadOutput(item, remoteJid, caption);
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
        const failText = `❌ não consegui baixar: ${friendlyDownloadError(error)}`;
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
      return this.convertTarget(parsedCommand, resolved, remoteJid);
    }

    if (parsedCommand.command === "formatos") {
      await this.safeSendMessage(remoteJid, { text: await this.describeFormats(resolved.media) });
      return true;
    }

    if (parsedCommand.command === "transcrever") {
      await this.safeSendMessage(remoteJid, { text: await this.transcribeTarget(resolved.media, remoteJid) });
      return true;
    }

    if (parsedCommand.command === "ler") {
      await this.safeSendMessage(remoteJid, { text: await this.readImageTarget(resolved.media, remoteJid) });
      return true;
    }

    throw new Error(`unsupported media command: ${parsedCommand.command}`);
  }

  /** .convert <formato>: pelo Convenus (aceita muito mais formato); ffmpeg local de reserva. */
  async convertTarget(parsedCommand, resolved, remoteJid) {
    const raw = String(parsedCommand.args?.[0] ?? "").toLowerCase().replace(/^\./, "");
    const p = this.runtime?.defaults?.commandPrefix ?? ".";
    if (!raw) {
      const options = await this.convertOptions(resolved.media).catch(() => null);
      await this.safeSendMessage(remoteJid, {
        text: options?.length
          ? `pra qual formato? dá pra: ${options.join(", ")}\nex.: ${p}convert ${options[0]}`
          : `fala o formato, ex.: ${p}convert mp3 · ${p}convert png · ${p}convert pdf`
      });
      return true;
    }
    const format = raw === "jpeg" ? "jpg" : raw;
    await this.sendPresence("composing", remoteJid);
    await this.safeSendMessage(remoteJid, { text: `🔄 convertendo ${mediaLabel(resolved.media)} → *${format.toUpperCase()}*…` });
    const convenus = this.runtime?.convenus;
    let output = null;
    if (convenus?.isConfigured?.()) {
      try {
        const out = await convenus.convertFile(resolved.media.path, format, { name: resolved.media.fileName ?? null });
        output = fileOutput(out.path, `convertido.${format}`, { from: out.from, to: format });
      } catch (error) {
        if (!error?.unreachable && error?.status === 400) {
          await this.sendPresence("paused", remoteJid);
          await this.safeSendMessage(remoteJid, { text: `❌ ${error.message}` });
          return true;
        }
        console.warn(`${this.logPrefix} convert via Convenus falhou (${error?.message ?? error}); usando ffmpeg local`);
      }
    }
    if (!output) {
      const localFormat = normalizeConvertFormat(format);
      if (!localFormat) {
        await this.sendPresence("paused", remoteJid);
        await this.safeSendMessage(remoteJid, { text: `❌ não sei converter pra ${format} agora. Tenta mp4, mp3, gif, png, jpg ou webp.` });
        return true;
      }
      output = await convertMedia(resolved.media.path, localFormat, this.runtime.defaults.commandMediaDerivedPath, {
        sourceMediaType: resolved.media.type
      });
    }
    await this.sendPresence("paused", remoteJid);
    return output;
  }

  /** Lista de formatos possíveis pro arquivo (via Convenus). */
  async convertOptions(media) {
    const up = await this.runtime?.convenus?.upload?.(media.path, { name: media.fileName ?? null });
    return (up?.targets ?? []).map((t) => t.to).filter((t) => t !== "unpack");
  }

  async describeFormats(media) {
    const convenus = this.runtime?.convenus;
    if (!convenus?.isConfigured?.()) return "conversor indisponível agora 😕";
    try {
      const up = await convenus.upload(media.path, { name: media.fileName ?? null });
      const groups = new Map();
      for (const t of up.targets ?? []) {
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group).push(t.to);
      }
      const p = this.runtime?.defaults?.commandPrefix ?? ".";
      const lines = [`🔄 *${up.desc || "arquivo"}* pode virar:`];
      for (const [group, list] of groups) lines.push(`• ${group}: ${list.join(", ")}`);
      const first = up.targets?.[0]?.to;
      if (first) lines.push("", `responde ele com ${p}convert <formato> (ex.: ${p}convert ${first})`);
      return lines.join("\n");
    } catch (error) {
      return `não consegui ler esse arquivo: ${error?.message ?? error}`;
    }
  }

  async transcribeTarget(media, remoteJid) {
    const transcriber = this.runtime?.audioTranscriber;
    if (!transcriber?.transcribe) return "transcrição indisponível agora 😕";
    if (!["audio", "video", "ptt", "voice", "gif"].includes(media.type) && !/^(audio|video)\//.test(media.mimetype ?? "")) {
      return "isso não é áudio nem vídeo 🤔 responde um áudio/vídeo com .transcrever";
    }
    await this.sendPresence("composing", remoteJid);
    try {
      const result = await transcriber.transcribe({ filePath: media.path, mimetype: media.mimetype ?? "audio/ogg" });
      if (!result?.text) return "🔇 não ouvi fala nenhuma nesse áudio";
      return `📝 *transcrição:*\n${result.text}`;
    } catch (error) {
      return `não consegui transcrever: ${error?.message ?? error}`;
    } finally {
      await this.sendPresence("paused", remoteJid);
    }
  }

  async readImageTarget(media, remoteJid) {
    if (!["image", "sticker"].includes(media.type)) return "isso não é imagem 🤔 responde uma foto ou figurinha com .ler";
    const vision = this.runtime?.primaryVisionAnalyzer;
    await this.sendPresence("composing", remoteJid);
    try {
      const prompt =
        "Descreva esta imagem em português do Brasil para uma pessoa com baixa visão: o que aparece, onde, cores e clima, em até 5 frases curtas. " +
        "Depois, se houver texto escrito na imagem, transcreva TODO o texto exatamente como está, numa seção 'Texto na imagem:'. Se não houver texto, não crie essa seção.";
      let text = null;
      if (vision?.client?.chat) {
        // Figurinha animada / webp: um quadro só basta pra ler.
        text = await vision.client.chat([{ role: "user", content: prompt }], { imagePaths: [media.path], detail: "high", maxTokens: 900 });
      } else if (vision?.analyze) {
        text = await vision.analyze({ filePath: media.path, mediaType: "image" });
      }
      text = String(text ?? "").trim();
      return text ? `👁️ *descrição:*\n${text}` : "não consegui enxergar essa imagem 😕";
    } catch (error) {
      return `não consegui ler a imagem: ${error?.message ?? error}`;
    } finally {
      await this.sendPresence("paused", remoteJid);
    }
  }

  /** .linkinfo: o que tem no link, sem baixar. */
  async describeLink(url) {
    const convenus = this.runtime?.convenus;
    if (!convenus?.isConfigured?.()) return "conversor indisponível agora 😕";
    try {
      const info = await convenus.info(url);
      const items = info.items ?? [];
      const videos = items.filter((i) => i.kind === "video");
      const images = items.filter((i) => i.kind === "image");
      const audios = items.filter((i) => i.kind === "audio");
      const heights = [...new Set(videos.flatMap((v) => v.heights ?? []))].sort((a, b) => b - a);
      const subs = [...new Map(items.flatMap((i) => i.subs ?? []).map((s) => [s.lang, s])).values()];
      const p = this.runtime?.defaults?.commandPrefix ?? ".";
      return [
        `🔎 *${info.title || "sem título"}*`,
        info.platform ? `• site: ${info.platform}${info.uploader ? ` · ${info.uploader}` : ""}` : null,
        info.duration ? `• duração: ${fmtDuration(info.duration)}` : null,
        `• tem: ${[videos.length && `${videos.length} vídeo(s)`, images.length && `${images.length} foto(s)`, audios.length && `${audios.length} áudio(s)`].filter(Boolean).join(", ") || "nada baixável"}`,
        heights.length ? `• qualidades: ${heights.map((h) => `${h}p`).join(", ")}` : null,
        subs.length ? `• legendas: ${subs.slice(0, 12).map((s) => `${s.lang}${s.auto ? "*" : ""}`).join(", ")}${subs.some((s) => s.auto) ? " (* = automática)" : ""}` : null,
        "",
        `baixar: ${p}dl <link> · só áudio: ${p}mp3 <link>${subs.length ? ` · legenda: ${p}legenda <link> ${subs[0].lang}` : ""}`
      ]
        .filter((l) => l !== null)
        .join("\n");
    } catch (error) {
      return `não consegui abrir esse link: ${friendlyDownloadError(error)}`;
    }
  }

  /**
   * Envio de download: uma mensagem só (antes ia prévia + documento duplicado). Vídeo até 60 MB
   * vai como vídeo; maior, áudio e legenda vão como documento (com nome e legenda da mensagem).
   */
  async sendDownloadOutput(output, remoteJid, caption = null) {
    if (!output?.path || !existsSync(output.path)) return;
    const buffer = readFileSync(output.path);
    const size = buffer.length;
    const withCaption = (payload) => (caption ? { ...payload, caption } : payload);
    if (output.kind === "image") {
      await this.safeSendMessage(remoteJid, withCaption({ image: buffer, mimetype: output.mimetype }));
      return;
    }
    if (output.kind === "video" && size <= 60 * 1024 * 1024) {
      await this.safeSendMessage(remoteJid, withCaption({ video: buffer, mimetype: "video/mp4", fileName: output.fileName }));
      return;
    }
    await this.safeSendMessage(remoteJid, withCaption(buildWaDocumentPayload(buffer, output)));
  }

  async sendOutput(parsedCommand, output, remoteJid) {
    const outBuffer = output.path ? readFileSync(output.path) : null;

    if (parsedCommand.command === "removebg") {
      await this.safeSendMessage(
        remoteJid,
        buildWaDocumentPayload(outBuffer, {
          mimetype: output.mimetype ?? "image/png",
          fileName: output.fileName ?? "sem-fundo.png"
        })
      );
      return;
    }

    if (parsedCommand.command === "toimg") {
      await this.sendToImgOutput(output, outBuffer, remoteJid);
      return;
    }

    if (parsedCommand.command === "convert" && !output.gifPlayback) {
      const ext = (output.fileName ?? output.path ?? "").split(".").pop().toUpperCase();
      const size = output.path && existsSync(output.path) ? ` · ${fmtSize(readFileSync(output.path).length)}` : "";
      await this.sendDownloadOutput(output, remoteJid, `✅ convertido${output.from ? ` de ${output.from}` : ""} pra *${ext}*${size}`);
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
    const payload = buildWaMediaPayload(outBuffer, output);
    await this.safeSendMessage(remoteJid, payload);
    await this.safeSendMessage(remoteJid, buildWaDocumentPayload(outBuffer, output));
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
        // convert/formatos/transcrever/ler mandam a própria confirmação dentro de processCommand.

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
      const gifPath = output.toimgGifPath;
      const gifBuffer = gifPath && existsSync(gifPath) ? readFileSync(gifPath) : null;
      const gifDocMeta = {
        mimetype: "image/gif",
        fileName: "sticker-convertido.gif"
      };

      if (outBuffer) {
        const playbackMime = output.toimgPlaybackMime ?? "video/mp4";
        await this.safeSendMessage(
          remoteJid,
          buildWaGifPlaybackPayload(outBuffer, {
            mimetype: playbackMime,
            seconds: output.toimgPlaybackSeconds
          })
        );
        if (gifBuffer) {
          await this.safeSendMessage(remoteJid, buildWaDocumentPayload(gifBuffer, gifDocMeta));
        }
        return;
      }

      if (gifBuffer) {
        await this.safeSendMessage(
          remoteJid,
          buildWaGifPlaybackPayload(gifBuffer, { mimetype: "image/gif" })
        );
        await this.safeSendMessage(remoteJid, buildWaDocumentPayload(gifBuffer, gifDocMeta));
      }
      return;
    }

    await this.safeSendMessage(remoteJid, { image: outBuffer });
    await this.safeSendMessage(
      remoteJid,
      buildWaDocumentPayload(outBuffer, {
        mimetype: "image/png",
        fileName: "sticker-convertido.png"
      })
    );
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

    if (!this.runtime?.imageGenerationService?.generate) {
      await this.safeSendMessage(remoteJid, { text: "geração de imagem tá desligada agora 😕" });
      return true;
    }
    await this.sendPresence("composing", remoteJid);
    await this.safeSendMessage(remoteJid, { text: `🎨 desenhando: _${prompt.slice(0, 200)}_… (leva uns 30s)` });
    const result = await this.runtime.imageGenerationService.generate({
      prompt,
      userId
    });
    await this.sendPresence("paused", remoteJid);

    if (result?.ok && result.buffer) {
      await this.safeSendMessage(remoteJid, { image: result.buffer, caption: "✅ prontinho" });
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
