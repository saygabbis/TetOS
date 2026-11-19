import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import { MediaProcessor } from "../../core/media/mediaProcessor.js";
import { UrlDownloadService } from "../../core/media/urlDownloadService.js";
import { convertMedia, normalizeConvertFormat } from "../../core/media/mediaConverter.js";
import { resolveStickerDurationArg } from "../../core/media/stickerDurationParse.js";
import { resolveRemoveBgOptions } from "../../core/media/removeBgOptionsParse.js";
import { parseUrlDownloadArgs } from "../whatsapp/commands/urlDownloadArgsParse.js";
import { isUrlMediaCommand, toUrlCommand } from "../whatsapp/commands/mediaCommandParser.js";
import { STYLES, fmtSize, friendlyDownloadError, runLinkCommand } from "../../core/media/linkCommandRunner.js";
import { editMediaTarget } from "../../core/media/mediaEditCommands.js";

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
    ytDlpTimeoutMs: defaults.ytDlpTimeoutMs ?? 120000,
    convenus: runtime?.convenus ?? null
  });
  const inboxDir = defaults.discordMediaPath ?? "./data/media/discord";
  const emojiDir = join(inboxDir, "emoji");

  const prefix = defaults.commandPrefix || ".";
  const style = STYLES.discord;
  const toFile = (o) => ({ path: o.path, name: o.fileName ?? basename(o.path), label: o.label ?? null });

  /** Arquivo acima do limite do Discord: comprime pelo Convenus antes de mandar. */
  async function fitFile(file, notify) {
    if (!file?.path || !existsSync(file.path) || statSync(file.path).size <= DISCORD_UPLOAD_LIMIT) return { file };
    const size = statSync(file.path).size;
    if (!runtime?.convenus?.compressFile) return { file, tooBig: true };
    await notify?.(`🗜️ ficou com ${fmtSize(size)} e o Discord só aceita 10 MB: comprimindo…`);
    try {
      const c = await runtime.convenus.compressFile(file.path, 9.3, { name: file.name });
      return { file: { ...file, path: c.path, name: `${String(file.name ?? "arquivo").replace(/\.[^.]+$/, "")}${extname(c.path)}` }, note: `comprimido de ${fmtSize(size)} pra ${fmtSize(c.size)}` };
    } catch {
      return { file, tooBig: true };
    }
  }

  /**
   * Roda um comando de mídia/link. `input` = mídia já baixada (pode ser null p/ link, .gerar).
   * notify(text): aviso no canal durante o trabalho ("⬇️ baixando…").
   * Retorna { files: [{ path, name }], text } ou { error }.
   */
  async function run(command, args = [], { input = null, userId = "default", big = false, notify = null } = {}) {
    const cmd = String(command ?? "").toLowerCase();

    if (cmd === "gerar") {
      const prompt = args.join(" ").trim();
      if (!prompt) return { error: "me fala o que é pra desenhar, tipo `.gerar gato de chapéu`" };
      await notify?.(`🎨 desenhando: *${prompt.slice(0, 200)}*… (leva uns 30s)`);
      const out = await runtime.imageGenerationService?.generate?.({ prompt, userId });
      if (!out?.ok) return { error: `não rolou gerar: ${out?.error ?? "geração desligada"}` };
      return { files: [{ path: out.filePath, name: "teto-gerou.png" }], text: "✅ prontinho" };
    }

    if (isUrlMediaCommand(cmd, args)) {
      const urlCmd = toUrlCommand({ command: cmd, args });
      const parsed = parseUrlDownloadArgs(urlCmd.command, urlCmd.args);
      if (parsed.error) return { error: parsed.error };
      try {
        const r = await runLinkCommand(parsed, { downloader, convenus: runtime?.convenus ?? null, prefix, notify, style, maxBytes: DISCORD_UPLOAD_LIMIT });
        if (r.text) return { text: r.text };
        const files = [];
        const notes = [];
        for (const o of r.outputs ?? []) {
          const fit = await fitFile(toFile(o), notify);
          if (fit.tooBig) notes.push(`⚠️ ${fit.file.name} passou de 10 MB e não deu pra comprimir`);
          else files.push(fit.file);
        }
        return { files, text: [r.caption, r.extraText, ...notes].filter(Boolean).join("\n") };
      } catch (error) {
        return { error: `❌ não consegui: ${friendlyDownloadError(error)}` };
      }
    }

    if (!input?.path) return { error: "cadê a mídia? manda junto, ou responde a mensagem que tem a imagem/vídeo" };

    if (["cortar", "gif", "comprimir"].includes(cmd)) {
      const r = await editMediaTarget(cmd, args, input, { runtime, outputDir, prefix, notify, style, defaultMb: 9.3 });
      if (r.text) return { text: r.text };
      const fit = await fitFile(toFile(r.output), notify);
      if (fit.tooBig) return { error: "ficou grande demais pro Discord (10 MB) 😭 tenta um trecho menor" };
      return { files: [fit.file], text: [r.caption, fit.note].filter(Boolean).join("\n") };
    }

    if (cmd === "formatos") return { text: await describeFormats(input) };
    if (cmd === "transcrever") return { text: await transcribe(input) };
    if (cmd === "ler") return { text: await readImage(input) };

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
      const raw = String(args[0] ?? "").toLowerCase().replace(/^\./, "");
      const format = raw === "jpeg" ? "jpg" : raw;
      if (!format) {
        const up = await runtime?.convenus?.upload?.(input.path, { name: input.fileName ?? null }).catch(() => null);
        const options = (up?.targets ?? []).map((t) => t.to).filter((t) => !["unpack", "compress"].includes(t));
        return { text: options.length ? `pra qual formato? dá pra: ${options.join(", ")}\nex.: \`${prefix}convert ${options[0]}\`` : `fala o formato, tipo \`${prefix}convert mp4\` ou \`${prefix}convert pdf\`` };
      }
      await notify?.(`🔄 convertendo → **${format.toUpperCase()}**…`);
      let out = null;
      let from = null;
      if (runtime?.convenus?.isConfigured?.()) {
        try {
          const c = await runtime.convenus.convertFile(input.path, format, { name: input.fileName ?? null });
          out = { path: c.path, fileName: `${String(input.fileName ?? "convertido").replace(/\.[^.]+$/, "")}.${format}` };
          from = c.from;
        } catch (error) {
          if (!error?.unreachable && error?.status === 400) return { error: `❌ ${error.message}` };
        }
      }
      if (!out) {
        const localFormat = normalizeConvertFormat(format);
        if (!localFormat) return { error: `❌ não sei converter pra ${format} agora. Tenta mp4, mp3, gif, png, jpg ou webp.` };
        out = await convertMedia(input.path, localFormat, outputDir, { sourceMediaType: input.type });
      }
      const fit = await fitFile(toFile(out), notify);
      if (fit.tooBig) return { error: "o arquivo convertido passou de 10 MB 😭" };
      return { files: [fit.file], text: `✅ convertido${from ? ` de ${from}` : ""} pra **${format.toUpperCase()}** · ${fmtSize(statSync(fit.file.path).size)}${fit.note ? ` (${fit.note})` : ""}` };
    }
    return { error: `não conheço o comando ${cmd}` };
  }

  async function describeFormats(input) {
    const convenus = runtime?.convenus;
    if (!convenus?.isConfigured?.()) return "conversor indisponível agora 😕";
    try {
      const up = await convenus.upload(input.path, { name: input.fileName ?? null });
      const groups = new Map();
      for (const t of up.targets ?? []) {
        if (t.to === "compress") continue;
        if (!groups.has(t.group)) groups.set(t.group, []);
        groups.get(t.group).push(t.to);
      }
      const lines = [`🔄 **${up.desc || "arquivo"}** pode virar:`];
      for (const [group, list] of groups) lines.push(`• ${group}: ${list.join(", ")}`);
      lines.push("", `\`${prefix}convert <formato>\` converte · \`${prefix}comprimir 8\` deixa com até 8 MB`);
      return lines.join("\n");
    } catch (error) {
      return `não consegui ler esse arquivo: ${error?.message ?? error}`;
    }
  }

  async function transcribe(input) {
    const transcriber = runtime?.audioTranscriber;
    if (!transcriber?.transcribe) return "transcrição indisponível agora 😕";
    if (!["audio", "video"].includes(input.type)) return "isso não é áudio nem vídeo 🤔";
    try {
      const result = await transcriber.transcribe({ filePath: input.path, mimetype: input.mimetype ?? "audio/ogg" });
      return result?.text ? `📝 **transcrição:**\n${result.text}` : "🔇 não ouvi fala nenhuma nesse áudio";
    } catch (error) {
      return `não consegui transcrever: ${error?.message ?? error}`;
    }
  }

  async function readImage(input) {
    if (!["image", "gif"].includes(input.type)) return "isso não é imagem 🤔";
    const vision = runtime?.primaryVisionAnalyzer;
    try {
      const prompt =
        "Descreva esta imagem em português do Brasil para uma pessoa com baixa visão: o que aparece, onde, cores e clima, em até 5 frases curtas. " +
        "Depois, se houver texto escrito na imagem, transcreva TODO o texto exatamente como está, numa seção 'Texto na imagem:'. Se não houver texto, não crie essa seção.";
      let text = null;
      if (vision?.client?.chat) text = await vision.client.chat([{ role: "user", content: prompt }], { imagePaths: [input.path], detail: "high", maxTokens: 900 });
      else if (vision?.analyze) text = await vision.analyze({ filePath: input.path, mediaType: "image" });
      text = String(text ?? "").trim();
      return text ? `👁️ **descrição:**\n${text}` : "não consegui enxergar essa imagem 😕";
    } catch (error) {
      return `não consegui ler a imagem: ${error?.message ?? error}`;
    }
  }

  return { processor, downloader, run, inboxDir, emojiDir, fitFile };
}
