import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getUiMediaDir,
  mediaInputFromRef,
  mimeFromExt,
  saveUiMediaFile,
  toMediaRef
} from "./uiMediaStore.js";
import { resolveStickerAsset } from "../whatsapp/stickerAssets.js";
import {
  isBuiltinRepertoireKey,
  loadStickerCatalog,
  listRepertoireKeys,
  removeStickerFromRepertoire,
  saveStickerToRepertoireWithVision
} from "../whatsapp/stickerRepertoire.js";
import { parseUrlDownloadArgs } from "../whatsapp/urlDownloadArgsParse.js";
import { resolveStickerDurationArg } from "../../core/media/stickerDurationParse.js";
import { REMOVE_BG_MODEL_LABELS, resolveRemoveBgOptions } from "../../core/media/removeBgOptionsParse.js";

/** Erro com mensagem pronta para a bolha da Teto na interface. */
export class UiMediaError extends Error {}

export const UI_STICKER_COMMANDS = Object.freeze(["sticker", "fsticker", "csticker"]);
export const UI_MEDIA_COMMANDS = Object.freeze([
  ...UI_STICKER_COMMANDS,
  "optimize",
  "removebg",
  "toimg",
  "convert"
]);

function pickKind(output) {
  const mime = String(output?.mimetype ?? "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return output?.kind ?? "document";
}

/**
 * Executa na interface o que a Teto faz pelo WhatsApp: figurinhas, conversões,
 * downloads, geração de imagem e repertório — devolvendo MediaRefs em vez de enviar pelo Baileys.
 */
export class UiMediaService {
  constructor({ runtime, processor = null, downloader = null } = {}) {
    this.runtime = runtime;
    this.defaults = runtime?.defaults ?? {};
    this.dir = getUiMediaDir(this.defaults);
    this.stickersPath = this.defaults.stickersPath ?? "./data/stickers";
    this._processor = processor;
    this._downloader = downloader;
  }

  async getProcessor() {
    if (!this._processor) {
      const { MediaProcessor } = await import("../../core/media/mediaProcessor.js");
      this._processor = new MediaProcessor({
        outputDir: this.defaults.commandMediaDerivedPath ?? "./data/media/derived",
        maxStickerBytes: this.defaults.tetosStickerMaxBytes,
        removeBgApiKeys: this.defaults.removeBgApiKeys,
        removeBgModel: this.defaults.removeBgModel
      });
    }
    return this._processor;
  }

  async getDownloader() {
    if (!this._downloader) {
      const { UrlDownloadService } = await import("../../core/media/urlDownloadService.js");
      this._downloader = new UrlDownloadService({
        outputDir: this.defaults.commandMediaDerivedPath ?? "./data/media/derived",
        ytDlpPath: this.defaults.ytDlpPath ?? null,
        ytDlpTimeoutMs: this.defaults.ytDlpTimeoutMs ?? 120000
      });
    }
    return this._downloader;
  }

  /** Copia um arquivo de saída para o armazenamento da UI e devolve o MediaRef. */
  storeOutput(output, { sticker = false, animated = false } = {}) {
    if (!output?.path || !existsSync(output.path)) {
      throw new UiMediaError("o processamento não gerou nenhum arquivo");
    }
    const saved = saveUiMediaFile(output.path, {
      dir: this.dir,
      mimeType: output.mimetype ?? undefined,
      fileName: output.fileName ?? undefined,
      sticker,
      animated
    });
    return toMediaRef(saved);
  }

  /** @returns {{ attachments: object[], notes: string[] }} */
  async runMediaCommand({ command, args = [], ref }) {
    const cmd = String(command ?? "").toLowerCase();
    if (!UI_MEDIA_COMMANDS.includes(cmd)) {
      throw new UiMediaError(`comando de mídia desconhecido: ${command}`);
    }
    const media = ref ? mediaInputFromRef(ref, { dir: this.dir }) : null;
    if (!media) {
      throw new UiMediaError(
        "Não achei a mídia. Anexe uma imagem, vídeo ou figurinha na conversa e tente de novo."
      );
    }
    const processor = await this.getProcessor();
    const notes = [];

    if (UI_STICKER_COMMANDS.includes(cmd)) {
      const duration = resolveStickerDurationArg(args?.[0]);
      if (duration.error) throw new UiMediaError(duration.error);
      const mode = cmd === "fsticker" ? "contain" : cmd === "csticker" ? "crop" : "stretch";
      const output = await processor.toSticker(media, mode, { maxDurationMs: duration.maxDurationMs });
      return { attachments: [this.storeOutput(output, { sticker: true, animated: Boolean(output.isAnimated) })], notes };
    }

    if (cmd === "optimize") {
      if (media.type !== "sticker") {
        throw new UiMediaError("O optimize só funciona com figurinhas. Use uma figurinha (.webp) como anexo.");
      }
      const output = await processor.optimizeSticker(media);
      if (output.alreadyOptimized) {
        const kb = Math.round((output.sizeBytes ?? 0) / 1024);
        throw new UiMediaError(`Não deu pra comprimir mais esta figurinha (${kb} KiB).`);
      }
      if (output.previousSizeBytes && output.sizeBytes && output.sizeBytes < output.previousSizeBytes) {
        notes.push(
          `Figurinha otimizada: ${Math.round(output.previousSizeBytes / 1024)} KiB → ${Math.round(output.sizeBytes / 1024)} KiB.`
        );
      }
      return { attachments: [this.storeOutput(output, { sticker: true })], notes };
    }

    if (cmd === "removebg") {
      const opts = resolveRemoveBgOptions(args);
      if (opts.error) throw new UiMediaError(opts.error);
      const potency = opts.model ?? this.defaults.removeBgModel ?? "small";
      notes.push(`Fundo removido (${REMOVE_BG_MODEL_LABELS[potency] ?? potency}).`);
      try {
        const output = await processor.removeBackground(media, { background: opts.background, model: opts.model });
        return { attachments: [this.storeOutput(output)], notes };
      } catch (error) {
        throw new UiMediaError(
          media.type === "sticker"
            ? "Não consegui remover o fundo dessa figurinha. Estáticas funcionam melhor com 'forte'; animadas são instáveis."
            : `Não consegui remover o fundo desta mídia (${error.message}). Imagens estáticas funcionam melhor com 'forte'.`
        );
      }
    }

    if (cmd === "toimg") {
      if (media.type !== "sticker") {
        throw new UiMediaError("O toimg só funciona com figurinhas — use uma figurinha como anexo.");
      }
      const output = await processor.toMediaFromSticker(media);
      const gif = output.toimgGifPath && existsSync(output.toimgGifPath) ? output.toimgGifPath : null;
      if (output.kind === "video" || gif) {
        // GIF toca nativamente em <img>; o MP4 é o fallback (loop mudo no <video>).
        if (gif) {
          return {
            attachments: [this.storeOutput({ path: gif, mimetype: "image/gif", fileName: "sticker-convertido.gif" })],
            notes
          };
        }
        return { attachments: [this.storeOutput(output, { animated: true })], notes };
      }
      return { attachments: [this.storeOutput(output)], notes };
    }

    // convert
    const { convertMedia, normalizeConvertFormat } = await import("../../core/media/mediaConverter.js");
    const format = normalizeConvertFormat(args?.[0]);
    if (!format) throw new UiMediaError("Informe o formato de saída, ex.: .convert mp4 ou .convert png");
    const output = await convertMedia(
      media.path,
      format,
      this.defaults.commandMediaDerivedPath ?? "./data/media/derived",
      { sourceMediaType: media.type }
    );
    return {
      attachments: [this.storeOutput(output, { animated: output.gifPlayback === true })],
      notes: [`Convertido para .${format}.`]
    };
  }

  /** Downloads por link (youtube/twitter/instagram/...). */
  async runUrlDownload({ command, url, args = [] }) {
    const parsed = parseUrlDownloadArgs(command, [url, ...(args ?? [])].filter(Boolean));
    if (parsed.error) throw new UiMediaError(parsed.error);
    const downloader = await this.getDownloader();
    let output;
    try {
      output = await downloader.downloadByCommand(parsed.command, parsed.url, parsed.mode, parsed.quality);
    } catch (error) {
      throw new UiMediaError(
        `Não consegui baixar — link privado, expirado ou plataforma bloqueou. Detalhe: ${error.message ?? error}`
      );
    }
    const outputs = Array.isArray(output?.outputs) ? output.outputs : [output];
    return { attachments: outputs.filter((o) => o?.path).map((o) => this.storeOutput(o)), notes: [] };
  }

  async generateImage({ prompt, userId = "ui-user" }) {
    const service = this.runtime?.imageGenerationService;
    if (!service?.generate) throw new UiMediaError("A geração de imagem não está disponível.");
    const result = await service.generate({ prompt, userId });
    if (!result?.ok || !result.buffer) {
      throw new UiMediaError(`não consegui gerar: ${result?.error ?? "erro desconhecido"}`);
    }
    const attachment = this.storeOutput({
      path: result.filePath,
      mimetype: "image/png",
      fileName: "imagem-gerada.png"
    });
    return { attachments: [attachment], notes: [] };
  }

  /** Figurinha do repertório → MediaRef (copiada para a mídia da UI, para poder receber ações). */
  stickerAttachment(key) {
    const asset = resolveStickerAsset(key, this.stickersPath);
    if (!asset?.url) return null;
    return this.storeOutput({ path: asset.url, mimetype: "image/webp", fileName: `${asset.key}.webp` }, { sticker: true });
  }

  listStickers() {
    const catalog = loadStickerCatalog(this.stickersPath);
    const byKey = new Map((catalog.entries ?? []).map((e) => [e.key, e]));
    return listRepertoireKeys(this.stickersPath)
      .filter((key) => existsSync(join(this.stickersPath, `${key}.webp`)))
      .map((key) => {
        const entry = byKey.get(key) ?? {};
        return {
          key,
          displayName: entry.displayName ?? entry.label ?? null,
          description: entry.visionDescription ?? null,
          builtin: isBuiltinRepertoireKey(key),
          savedAt: entry.savedAt ?? null,
          url: `/ui/stickers/${encodeURIComponent(key)}/file`
        };
      });
  }

  stickerFilePath(key) {
    const safe = String(key ?? "");
    if (!/^[a-z0-9_-]+$/i.test(safe)) return null;
    const file = join(this.stickersPath, `${safe}.webp`);
    return existsSync(file) ? file : null;
  }

  removeSticker(key) {
    return removeStickerFromRepertoire({ basePath: this.stickersPath, key });
  }

  /** Salva uma mídia da UI no repertório (converte em figurinha se ainda não for). */
  async saveToRepertoire({ ref, key = null, label = null, userId = "ui-user" }) {
    const media = ref ? mediaInputFromRef(ref, { dir: this.dir }) : null;
    if (!media) throw new UiMediaError("Não achei a mídia para salvar no repertório.");
    let sourcePath = media.path;
    let animated = Boolean(media.isAnimated);
    if (media.type !== "sticker") {
      const processor = await this.getProcessor();
      const output = await processor.toSticker(media, "contain", {});
      sourcePath = output.path;
      animated = Boolean(output.isAnimated);
    }
    const saved = await saveStickerToRepertoireWithVision({
      runtime: this.runtime,
      sourcePath,
      basePath: this.stickersPath,
      key,
      messageId: ref.mediaId,
      savedFrom: "ui-desktop",
      label,
      media: { type: "sticker", path: sourcePath, isAnimated: animated },
      userId,
      remoteJid: "ui-desktop",
      skipVision: Boolean(key)
    });
    return saved;
  }

  setRepertoireMode(userId, enabled) {
    const store = this.runtime?.stickerRepertoireMode;
    if (!store) return false;
    if (enabled) store.enable(userId, { channelId: "ui-desktop", enabledBy: userId });
    else store.disable(userId);
    return true;
  }

  isRepertoireModeOn(userId) {
    const store = this.runtime?.stickerRepertoireMode;
    return Boolean(store?.isActive?.(userId));
  }
}

export { mimeFromExt };
