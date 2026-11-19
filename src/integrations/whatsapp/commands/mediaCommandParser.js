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
  "gerarhd",
  "editar",
  "editarhd",
  "mp3",
  "legenda",
  "linkinfo",
  "formatos",
  "transcrever",
  "ler",
  "cortar",
  "gif",
  "comprimir",
  "playlist",
  "perfil"
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
  "linkinfo",
  "playlist",
  "perfil"
]);

/** Funcionam com link OU com a mídia marcada (o link nos argumentos decide). */
const HYBRID_COMMANDS = Object.freeze(["cortar", "gif", "comprimir"]);

const ARG_URL_RE = /(?:^|[\s<(["'])https?:\/\//i;

export function argsHaveUrl(args = []) {
  return (args ?? []).some((a) => ARG_URL_RE.test(String(a ?? "")));
}

/**
 * .comprimir <link> 8 → .download <link> 8mb (baixa e comprime). Outros comandos passam iguais.
 */
export function toUrlCommand(parsedCommand) {
  if (parsedCommand?.command !== "comprimir") return parsedCommand;
  const args = (parsedCommand.args ?? []).map((a) => (/^\d+(?:[.,]\d+)?$/.test(String(a)) ? `${a}mb` : a));
  return { ...parsedCommand, command: "download", args: args.some((a) => /mb$/i.test(String(a))) ? args : [...args, "8mb"] };
}

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
  if (name === "editar" || name === "editarhd") return `Responde a imagem com ${cmd} <o que mudar>, ex.: ${cmd} troca o fundo por uma praia`;
  if (name === "cortar") return `Responde o vídeo/áudio com ${cmd} 0:10 0:30 (começo e fim), ou manda um link: ${cmd} <link> 1:20 1:45`;
  if (name === "gif") return `Responde o vídeo com ${cmd} (ou ${cmd} 2 8 pra um trecho), ou manda um link: ${cmd} <link> 0:10 0:16`;
  if (name === "comprimir") return `Responde o vídeo/áudio/imagem/PDF com ${cmd} 8 (fica com até 8 MB), ou ${cmd} <link> 8`;
  return `Responde a foto, vídeo ou figurinha com ${cmd} (ou manda ${cmd} na legenda do anexo).`;
}

/** Lista completa de comandos (gerada do catálogo). */
export function formatWhatsAppHelpText(prefix = ".", ctx = {}) {
  return formatHelpOverview(prefix, ctx);
}

/** Vai pelo caminho de link? (cortar/gif/comprimir só quando tem link nos argumentos). */
export function isUrlMediaCommand(command, args = null) {
  const c = String(command ?? "").toLowerCase();
  if (URL_MEDIA_COMMANDS.includes(c)) return true;
  return HYBRID_COMMANDS.includes(c) && argsHaveUrl(args ?? []);
}
