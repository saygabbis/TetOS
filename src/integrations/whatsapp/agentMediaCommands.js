/** Comandos de mídia do agente — equivalentes aos comandos com "." do WhatsApp. */
import { isKnownStickerKey } from "./stickerRepertoire.js";

export const AGENT_MEDIA_COMMANDS = Object.freeze([
  "sticker",
  "fsticker",
  "csticker",
  "optimize",
  "removebg",
  "toimg"
]);

export const SAVE_STICKER_COMMANDS = Object.freeze([
  "salvarsticker",
  "salvarrepertorio",
  "adicionarrepertorio",
  "adicionarsticker",
  "guardarsticker",
  "savesticker",
  "salvarepertorio"
]);

export const REPERTOIRE_MODE_COMMANDS = Object.freeze([
  "modorepertorio",
  "ativarrepertorio",
  "desativarrepertorio",
  "desligarrepertorio",
  "ligarrepertorio"
]);

export const AGENT_MEDIA_COMMAND_ALIASES = Object.freeze({
  fig: "sticker",
  figurinizar: "sticker",
  ffig: "fsticker",
  ffigurinha: "fsticker",
  cfig: "csticker",
  cfigurinha: "csticker",
  img: "toimg",
  imagem: "toimg",
  toimage: "toimg",
  toimagem: "toimg",
  toimg: "toimg",
  otimizar: "optimize",
  optimizar: "optimize",
  optimize: "optimize",
  rmbg: "removebg",
  "remove-bg": "removebg",
  removebg: "removebg"
});

export const PRESET_STICKER_KEYS = Object.freeze(
  new Set(["teto-linguinha", "teto-pao", "teto-saliente", "ack", "ok", "thumbs_up", "heart"])
);

export function isSaveStickerCommand(cmd) {
  return SAVE_STICKER_COMMANDS.includes(String(cmd ?? "").toLowerCase());
}

export function isRepertoireModeCommand(cmd) {
  return REPERTOIRE_MODE_COMMANDS.includes(String(cmd ?? "").toLowerCase());
}

export function parseRepertoireModeEnabled(args = []) {
  const arg = String(args[0] ?? "on").trim().toLowerCase();
  if (["off", "desligar", "desativar", "false", "0", "stop", "nao", "não"].includes(arg)) {
    return false;
  }
  return true;
}

export function normalizeAgentMediaCommand(cmd) {
  const raw = String(cmd ?? "").toLowerCase();
  return AGENT_MEDIA_COMMAND_ALIASES[raw] ?? raw;
}

/** Chaves de figurinha pré-definida / repertório (não message id). */
export function isPresetStickerKey(key, { stickersPath = null } = {}) {
  const k = String(key ?? "").trim().toLowerCase();
  if (!k) return false;
  if (PRESET_STICKER_KEYS.has(k)) return true;
  if (k.startsWith("teto-")) return true;
  if (/^[0-9A-F]{12,}$/i.test(k) && /[A-F]/i.test(k)) return false;
  if (/^\d{10,}$/.test(k)) return false;
  if (stickersPath && isKnownStickerKey(k, stickersPath)) return true;
  if (/^rep-[a-z0-9_-]+$/i.test(k)) return true;
  return true;
}

export function buildMediaAction(command, messageId, extraArgs = []) {
  const cmd = normalizeAgentMediaCommand(command);
  if (!AGENT_MEDIA_COMMANDS.includes(cmd) || !messageId) return null;
  return {
    type: "media",
    command: cmd,
    messageId: String(messageId).trim(),
    args: Array.isArray(extraArgs) ? extraArgs.filter(Boolean) : []
  };
}

export const AGENT_MEDIA_COMMAND_PATTERN =
  "sticker|figurinizar|fsticker|ffigurinha|csticker|cfigurinha|optimize|otimizar|optimizar|removebg|rmbg|toimage|toimg|toimagem";

export const SAVE_STICKER_COMMAND_PATTERN =
  "salvarsticker|salvarrepertorio|adicionarrepertorio|adicionarsticker|guardarsticker|savesticker|salvarepertorio";

export const REPERTOIRE_MODE_COMMAND_PATTERN =
  "modorepertorio|ativarrepertorio|desativarrepertorio|desligarrepertorio|ligarrepertorio";
