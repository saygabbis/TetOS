import {
  buildUrlDownloadAction,
  extractHttpUrlsFromText,
  inferDownloadCommandFromUrl
} from "../../integrations/whatsapp/commands/agentDownloadCommands.js";

function normalizeIntentText(text = "") {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function inferModeFromText(text = "") {
  const t = normalizeIntentText(text);
  if (/\b(thumb|thumbnail|miniatura|capa)\b/.test(t)) {
    return { command: "thumbnail", mode: null };
  }
  if (/\b(mp3|audio|som|musica)\b/.test(t)) return { command: null, mode: "mp3" };
  if (/\b(mp4|video)\b/.test(t)) return { command: null, mode: "mp4" };
  if (/\b(post|perfil|user|banner)\b/.test(t)) return { command: null, mode: "post" };
  return { command: null, mode: null };
}

/** Detecta pedido de download por URL (link na msg ou no quote). */
export function detectAgentUrlDownloadIntent(text = "", meta = {}) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.startsWith(".")) return null;

  const sources = [raw];
  const quoted = String(meta?.quotedMessage ?? "").trim();
  if (quoted) sources.push(quoted);

  let url = null;
  for (const src of sources) {
    const found = extractHttpUrlsFromText(src);
    if (found.length) {
      url = found[0];
      break;
    }
  }
  if (!url) return null;

  // Link compartilhado sozinho é pra ver/comentar, não pra baixar: só baixa com pedido explícito.
  const t = normalizeIntentText(raw.replace(/https?:\/\/\S+/gi, " "));
  const wantsDownload =
    /\b(baixa|baixar|baixe|baixo|download|dl|salva|salvar|salve)\b/.test(t) ||
    /\b(manda|mandar|manda ai|envia|enviar|pega|pegar|tira|tirar|converte|converter)\b.{0,30}\b(video|audio|mp3|mp4|musica|som|foto|imagem|thumb|thumbnail|arquivo|aqui)\b/.test(t) ||
    /\b(em|pra|para|no|como)\s+(mp3|mp4)\b/.test(t) ||
    /^\s*(mp3|mp4|thumb|thumbnail)\s*$/.test(t) ||
    /\b(thumb|thumbnail|miniatura)\b/.test(t);

  if (!wantsDownload) return null;

  let command = inferDownloadCommandFromUrl(url);
  const modeHint = inferModeFromText(`${raw} ${quoted}`);
  if (modeHint.command === "thumbnail") command = "thumbnail";

  const args = [];
  if (modeHint.mode) args.push(modeHint.mode);

  const action = buildUrlDownloadAction(command, url, args);
  if (!action) return null;

  return {
    command: action.command,
    url: action.url,
    args: action.args,
    source: "url_intent"
  };
}
