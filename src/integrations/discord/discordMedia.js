import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { MediaProcessor } from "../../core/media/mediaProcessor.js";
import { UrlDownloadService } from "../../core/media/urlDownloadService.js";
import { convertMedia, normalizeConvertFormat } from "../../core/media/mediaConverter.js";
import { resolveStickerDurationArg } from "../../core/media/stickerDurationParse.js";
import { resolveRemoveBgOptions } from "../../core/media/removeBgOptionsParse.js";
import { parseUrlDownloadArgs } from "../whatsapp/commands/urlDownloadArgsParse.js";
import { isUrlMediaCommand } from "../whatsapp/commands/mediaCommandParser.js";

/**
 * Mídia no Discord: baixa anexos (pra visão/transcrição e comandos) e roda os mesmos comandos do zap
 * (.sticker, .removebg, .toimg, .convert, downloads, .gerar) devolvendo arquivos pra mandar no canal.
 */

// Arquivo maior que isso o Discord recusa em servidor sem boost.
export const DISCORD_UPLOAD_LIMIT = 10 * 1024 * 1024;

const safeName = (name) => String(name ?? "arquivo").replace(/[^\w.\-]+/g, "_").slice(-80);

/** Tipo no vocabulário da Teto (o mesmo do zap). */
export function mediaTypeOf({ contentType = "", name = "" } = {}) {
  const ct = String(contentType ?? "").toLowerCase();
  const ext = extname(String(name ?? "")).toLowerCase();
  if (ct === "image/gif" || ext === ".gif") return "gif";
  if (ct.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "image";
  if (ct.startsWith("video/") || [".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
  if (ct.startsWith("audio/") || [".ogg", ".mp3", ".m4a", ".wav", ".opus"].includes(ext)) return "audio";
  return "document";
}

/** Anexos + figurinhas do Discord de uma mensagem, no formato { url, name, contentType, size, id }. */
export function mediaItemsOf(message) {
  const items = [...(message?.attachments?.values?.() ?? [])].map((a) => ({
    id: a.id,
    url: a.url,
    name: a.name,
    contentType: a.contentType ?? "",
    size: a.size ?? 0,
    isVoice: Boolean(a.duration ?? a.waveform)
  }));
  // Figurinha do Discord (PNG/APNG/GIF; Lottie não dá pra converter).
  for (const s of message?.stickers?.values?.() ?? []) {
    if (s.format === 3) continue;
    items.push({ id: s.id, url: s.url, name: `${safeName(s.name)}.${s.format === 4 ? "gif" : "png"}`, contentType: s.format === 4 ? "image/gif" : "image/png", size: 0, discordSticker: true });
  }
  return items;
}

export async function downloadMediaItem(item, dir) {
  if (!item?.url) throw new Error("anexo sem url");
  if (item.size && item.size > 25 * 1024 * 1024) throw new Error("arquivo grande demais");
  const res = await fetch(item.url);
  if (!res.ok) throw new Error(`download falhou (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${item.id ?? Date.now()}-${safeName(item.name)}`);
  writeFileSync(path, buf);
  const type = mediaTypeOf(item);
  return { path, type, mimetype: item.contentType || null, fileName: item.name, isAnimated: type === "gif", discordSticker: Boolean(item.discordSticker) };
}

/** Tamanho de emoji grande do Discord: figurinha aparece pequenininha, não como imagem gigante. */
export const EMOJI_PX = 48;

/**
 * Versão "emoji" de uma figurinha/imagem: 48 px, fundo transparente; animada vira GIF (o Discord não
 * anima webp de anexo). Fica em cache por arquivo + data de modificação.
 */
export async function emojiSizedImage(sourcePath, dir = "./data/media/discord/emoji", size = EMOJI_PX) {
  const meta = await sharp(sourcePath, { animated: true }).metadata();
  const animated = Number(meta.pages ?? 1) > 1;
  const ext = animated ? "gif" : "png";
  const stamp = Math.round(statSync(sourcePath).mtimeMs);
  const out = join(dir, `${basename(sourcePath, extname(sourcePath))}-${stamp}-${size}.${ext}`);
  if (!existsSync(out)) {
    mkdirSync(dir, { recursive: true });
    const img = sharp(sourcePath, { animated }).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
    await (animated ? img.gif({ loop: 0 }) : img.png()).toFile(out);
  }
  return { path: out, ext };
}

export function createDiscordMediaTools(runtime) {
  const defaults = runtime?.defaults ?? {};
  const outputDir = defaults.commandMediaDerivedPath ?? "./data/media/derived";
  const processor = new MediaProcessor({
    outputDir,
    removeBgApiKeys: defaults.removeBgApiKeys,
    removeBgModel: defaults.removeBgModel
  });
  const downloader = new UrlDownloadService({
    outputDir,
    ytDlpPath: defaults.ytDlpPath ?? null,
    ytDlpTimeoutMs: defaults.ytDlpTimeoutMs ?? 120000
  });
  const inboxDir = defaults.discordMediaPath ?? "./data/media/discord";
  const emojiDir = join(inboxDir, "emoji");

  /**
   * Roda um comando de mídia. `input` = mídia já baixada (pode ser null p/ downloads e .gerar).
   * Retorna { files: [{ path, name }], text } ou { error }.
   */
  async function run(command, args = [], { input = null, userId = "default", big = false } = {}) {
    const cmd = String(command ?? "").toLowerCase();

    if (cmd === "gerar") {
      const prompt = args.join(" ").trim();
      if (!prompt) return { error: "me fala o que é pra desenhar, tipo `.gerar gato de chapéu`" };
      const out = await runtime.imageGenerationService?.generate?.({ prompt, userId });
      if (!out?.ok) return { error: `não rolou gerar: ${out?.error ?? "geração desligada"}` };
      return { files: [{ path: out.filePath, name: "teto-gerou.png" }] };
    }

    if (isUrlMediaCommand(cmd)) {
      const parsed = parseUrlDownloadArgs(cmd, args);
      if (parsed.error) return { error: parsed.error };
      const output = await downloader.downloadByCommand(parsed.command, parsed.url, parsed.mode, parsed.quality);
      const outputs = (Array.isArray(output?.outputs) ? output.outputs : [output]).filter((o) => o?.path);
      return { files: outputs.map((o) => ({ path: o.path, name: o.fileName ?? undefined })) };
    }

    if (!input?.path) return { error: "cadê a mídia? manda junto, ou responde a mensagem que tem a imagem/vídeo" };

    if (["sticker", "fsticker", "csticker"].includes(cmd)) {
      const duration = resolveStickerDurationArg(args[0]);
      if (duration.error) return { error: duration.error };
      if (!["image", "gif", "video", "sticker"].includes(input.type)) return { error: "figurinha só sai de imagem, gif ou vídeo" };
      const mode = cmd === "fsticker" ? "contain" : cmd === "csticker" ? "crop" : "stretch";
      const out = await processor.toSticker(input, mode, { maxDurationMs: duration.maxDurationMs });
      // No Discord a figurinha vai no tamanho de emoji; `grande` manda o webp inteiro (pra salvar).
      if (!big) {
        const small = await emojiSizedImage(out.path, emojiDir);
        return { files: [{ path: small.path, name: `figurinha.${small.ext}` }] };
      }
      return { files: [{ path: out.path, name: "figurinha.webp" }] };
    }
    if (cmd === "optimize") {
      const out = await processor.optimizeSticker(input);
      if (out.alreadyOptimized) return { text: "essa já tá no menor tamanho que dá" };
      return { files: [{ path: out.path, name: "figurinha.webp" }] };
    }
    if (cmd === "removebg") {
      const opts = resolveRemoveBgOptions(args);
      if (opts.error) return { error: opts.error };
      const out = await processor.removeBackground(input, { background: opts.background, model: opts.model });
      return { files: [{ path: out.path, name: out.fileName ?? "sem-fundo.png" }] };
    }
    if (cmd === "toimg") {
      // No Discord "figurinha" é qualquer webp: se não for, já é imagem.
      const out = await processor.toMediaFromSticker({ ...input, type: "sticker" });
      const path = out.toimgGifPath ?? out.path;
      return { files: [{ path, name: `imagem${extname(path) || ".png"}` }] };
    }
    if (cmd === "convert") {
      const format = normalizeConvertFormat(args[0]);
      if (!format) return { error: "fala o formato, tipo `.convert mp4` ou `.convert png`" };
      const out = await convertMedia(input.path, format, outputDir, { sourceMediaType: input.type });
      return { files: [{ path: out.path, name: out.fileName }] };
    }
    return { error: `não conheço o comando ${cmd}` };
  }

  return { processor, downloader, run, inboxDir, emojiDir };
}
