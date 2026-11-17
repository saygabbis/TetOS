import { resolveCommand } from "./commandCatalog.js";
import { formatHelpOverview } from "./commandHelp.js";

/** Comandos que o MediaCommandService executa (os apelidos e erros de digitação vêm do catálogo). */
const MEDIA_COMMANDS = Object.freeze([
  "sticker",
  "fsticker",
  "csticker",
  "toimg",
  "optimize",
  "removebg",
  "help",
  "repertorio",
  "youtube",
  "twitter",
  "instagram",
  "reddit",
  "tiktok",
  "facebook",
  "download",
  "thumbnail",
  "convert",
  "gerar",
  "mp3",
  "legenda",
  "linkinfo",
  "formatos",
  "transcrever",
  "ler"
]);

/** Comandos que recebem um link (e não uma mídia marcada). */
const URL_MEDIA_COMMANDS = Object.freeze([
  "youtube",
  "twitter",
  "instagram",
  "reddit",
  "tiktok",
  "facebook",
  "download",
  "thumbnail",
  "mp3",
  "legenda",
  "linkinfo"
]);

export function parseWhatsAppCommand(text = "", prefix = ".") {
  const resolved = resolveCommand(text, prefix);
  if (!resolved?.cmd || !["known", "corrected"].includes(resolved.kind)) return null;
  const command = resolved.cmd.name;
  if (!MEDIA_COMMANDS.includes(command)) return null;
  return { command, args: resolved.args ?? [], ...(resolved.kind === "corrected" ? { correctedFrom: resolved.token } : {}) };
}

export function formatMissingMediaCommandHint(command = "sticker", prefix = ".") {
  const p = prefix || ".";
  const name = String(command || "sticker").trim() || "sticker";
  const cmd = `${p}${name}`;
  if (name === "convert") {
    return `Responde o arquivo com ${cmd} <formato> ou manda na legenda do anexo. Ex.: ${p}convert mp3 · ${p}convert pdf`;
  }
  if (name === "transcrever") return `Responde um áudio ou vídeo com ${cmd} que eu escrevo o que foi falado.`;
  if (name === "ler") return `Responde uma imagem (ou figurinha) com ${cmd} que eu descrevo e leio o texto dela.`;
  if (name === "formatos") return `Responde um arquivo com ${cmd} que eu digo em que ele pode virar.`;
  return `Responde a foto, vídeo ou figurinha com ${cmd} (ou manda ${cmd} na legenda do anexo).`;
}

/** Lista completa de comandos (gerada do catálogo). */
export function formatWhatsAppHelpText(prefix = ".", ctx = {}) {
  return formatHelpOverview(prefix, ctx);
}

export function isUrlMediaCommand(command) {
  return URL_MEDIA_COMMANDS.includes(String(command ?? "").toLowerCase());
}
