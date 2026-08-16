const MEDIA_COMMAND_ALIASES = Object.freeze({
  fig: "sticker",
  figurinha: "sticker",
  sticker: "sticker",
  stiker: "sticker",
  ffig: "fsticker",
  ffigurinha: "fsticker",
  fsticker: "fsticker",
  fstiker: "fsticker",
  cfig: "csticker",
  cfigurinha: "csticker",
  csticker: "csticker",
  cstiker: "csticker",
  img: "toimg",
  imagem: "toimg",
  toimg: "toimg",
  optimize: "optimize",
  otimizar: "optimize",
  optimizar: "optimize",
  removebg: "removebg",
  rmbg: "removebg",
  "remove-bg": "removebg",
  rep: "repertorio",
  repertorio: "repertorio",
  ajuda: "help",
  help: "help",
  comandos: "help",
  commands: "help",
  yt: "youtube",
  x: "twitter",
  tt: "twitter",
  insta: "instagram",
  rd: "reddit",
  tk: "tiktok",
  ttok: "tiktok",
  fb: "facebook",
  dl: "download",
  baixar: "download",
  thumb: "thumbnail",
  converter: "convert",
  gerar: "gerar",
  imagem: "gerar",
  generate: "gerar",
  draw: "gerar"
});

export const MEDIA_COMMANDS = Object.freeze([
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
  "gerar"
]);

export const URL_MEDIA_COMMANDS = Object.freeze([
  "youtube",
  "twitter",
  "instagram",
  "reddit",
  "tiktok",
  "facebook",
  "download",
  "thumbnail"
]);

function stripLeadingMentionsAndMarks(text = "") {
  return String(text ?? "")
    .replace(/^[\u200e\u200f\u202a-\u202e\u2066-\u2069\s]+/, "")
    .replace(/^(?:@(?:teto|kasane(?:\s+teto)?|\d{5,}|\S+)\s+)+/i, "")
    .trim();
}

export function parseWhatsAppCommand(text = "", prefix = ".") {
  const raw = stripLeadingMentionsAndMarks(text);
  if (!raw.startsWith(prefix)) return null;
  const withoutPrefix = raw.slice(prefix.length).trim();
  if (!withoutPrefix) return null;
  const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
  const command = String(cmdRaw ?? "").toLowerCase();
  const normalized = MEDIA_COMMAND_ALIASES[command] ?? command;
  if (!MEDIA_COMMANDS.includes(normalized)) return null;
  return { command: normalized, args };
}

function foldCommandText(text = "") {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[\u200e\u200f]+/, "")
    .replace(/^(?:@(?:teto|kasane(?:\s+teto)?|\d+|\S+)\s+)+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pedido curto em linguagem natural (anexo/reply). Evita ir pra LLM.
 * Não casa papo tipo "adorei essa figurinha".
 */
export function parseNaturalWhatsAppMediaCommand(text = "") {
  const t = foldCommandText(text);
  if (!t || t.startsWith(".") || t.length > 80) return null;
  if (/\b(adorei|amei|kkk+|haha|mandou|recebi|toda hora|demais)\b/.test(t)) return null;

  const core = t
    .replace(/^(?:(?:teto|tete)[,\s]+)/, "")
    .replace(/^(?:(?:pode(?:s)?|consegue)\s+)/, "")
    .replace(/^(?:(?:por favor|pfv|pf)\s+)/, "")
    .replace(/^(?:(?:me|pra mim)\s+)/, "")
    .replace(/^(?:(?:essa|esse|isso|isto)(?:\s+daqui)?(?:\s+(?:foto|imagem|video|gif))?\s+)/, "")
    .trim();

  if (
    /^(?:(?:faz(?:er)?|cria|manda|transforma(?:r)?|vira(?:r)?|converte(?:r)?)(?:\s+(?:isso|essa|este|esta|disso|dessa))?(?:\s+em)?\s+)?(?:uma?\s+)?(?:figurinha|sticker|fig)(?:\s+\d+\s*s(?:eg(?:undos)?)?)?(?:\s+(?:disso|dessa|desse|ai|pra mim|pfv|por favor|dessa foto|desse video))?$/.test(
      core
    )
  ) {
    const dur = t.match(/(\d+)\s*s/);
    return { command: "sticker", args: dur ? [`${dur[1]}s`] : [] };
  }
  if (
    /^(?:(?:faz(?:er)?|cria|manda|transforma(?:r)?|vira(?:r)?|converte(?:r)?)(?:\s+(?:isso|essa|este|esta|disso|dessa))?(?:\s+em)?\s+)?(?:uma?\s+)?(?:imagem|foto|gif|png|jpg)$/.test(
      core
    )
  ) {
    return { command: "toimg", args: [] };
  }
  if (/^(?:remove|tira)\s+(?:o\s+)?fundo(?:\s+\w+)*$/.test(core) || /^(?:rmbg|removebg)$/.test(core)) {
    const args = core.replace(/^(?:remove|tira)\s+(?:o\s+)?fundo\s*/i, "").split(/\s+/).filter(Boolean);
    return { command: "removebg", args };
  }
  if (/^(?:otimiza(?:r)?|comprim(?:e|ir)|reduz)\s*(?:a\s+)?(?:figurinha|sticker)?$/.test(core)) {
    return { command: "optimize", args: [] };
  }
  return null;
}

export function formatMissingMediaCommandHint(command = "sticker", prefix = ".") {
  const p = prefix || ".";
  const name = String(command || "sticker").trim() || "sticker";
  const cmd = `${p}${name}`;
  if (name === "convert") {
    return `Marca a mídia com reply ou manda ${cmd} na legenda do anexo. Ex.: ${p}convert mp4`;
  }
  return `Marca a mídia com reply (responde a foto, vídeo ou figurinha) ou manda ${cmd} na legenda do anexo.`;
}

export function formatWhatsAppHelpText(prefix = ".") {
  const p = prefix || ".";
  const c = (name) => `${p}${name}`;
  const line = "━━━━━━━━━━━━━━━━━━━━━━";
  const dot = "▸";

  return [
    "✦ *Comandos TetOS* ✦",
    line,
    "",
    `📋 *Geral*`,
    `${dot} ${c("help")} — esta lista (${p}ajuda, ${p}comandos)`,
    `${dot} *${c("tetos")}* \`<mensagem>\` — pergunta pontual à IA (sem conversa contínua)`,
    `${dot} ${c("repertorio")} on|off — auto-salva figurinhas recebidas`,
    `${dot} ${c("repertorio")} remover — tira do repertório (marque a figurinha com reply antes)`,
    "",
    `⚡ *Ativar / desativar a Teto*`,
    `${dot} *${c("teto-ativar")}* — ativa no privado (PV)`,
    `${dot} *${c("teto-desativar")}* — desativa no privado`,
    `${dot} *${c("teto-grupo-ativar")}* — ativa no grupo`,
    `${dot} *${c("teto-grupo-desativar")}* — desativa no grupo`,
    `   └ no grupo ainda precisa @ ou reply depois de ativar`,
    `   └ também aceita /teto-ativar (com barra)`,
    "",
    `🎨 *Figurinhas & imagem*`,
    `${dot} *${c("sticker")}* — imagem/vídeo/GIF → figurinha (stretch)`,
    `   └ reply ou anexo (legenda) · duração: ${c("sticker")} 10s`,
    `${dot} *${c("fsticker")}* — figurinha sem cortar (contain)`,
    `${dot} *${c("csticker")}* — recorta o centro (crop)`,
    `${dot} *${c("optimize")}* — comprime figurinha (${p}otimizar)`,
    `${dot} *${c("removebg")}* — remove fundo`,
    `   └ ${c("removebg")} verde · potência: leve | media | forte`,
    `${dot} *${c("toimg")}* — figurinha → imagem ou GIF/vídeo`,
    `${dot} *${c("gerar")}* \`<prompt>\` — gera imagem por IA (${p}imagem)`,
    "",
    `🔗 *Download de links*`,
    `   └ qualidade opcional: full (max) · mid · low (min)`,
    `${dot} *${c("youtube")}* / ${c("yt")} \`<link>\` [mp3|mp4] [full|mid|low]`,
    `${dot} *${c("twitter")}* / ${c("x")} / ${c("tt")} \`<link>\` [mp3|mp4|post|user|banner] [full|mid|low]`,
    `${dot} *${c("instagram")}* / ${c("insta")} \`<link>\` [mp3|mp4|post|user] [full|mid|low]`,
    `${dot} *${c("reddit")}* / ${c("rd")} \`<link>\` [mp3|mp4|post|user] [full|mid|low]`,
    `${dot} *${c("tiktok")}* / ${c("tk")} / ${c("ttok")} \`<link>\` [mp3|mp4] [full|mid|low]`,
    `${dot} *${c("facebook")}* / ${c("fb")} \`<link>\` [mp3|mp4|post] [full|mid|low]`,
    `${dot} *${c("download")}* / ${c("dl")} / ${c("baixar")} \`<link>\` [mp3|mp4|post] [full|mid|low]`,
    `   └ Twitch · Vimeo · Pinterest · SoundCloud · etc.`,
    `${dot} *${c("thumbnail")}* / ${c("thumb")} \`<link youtube>\``,
    "",
    `🔄 *Conversão*`,
    `${dot} *${c("convert")}* / ${c("converter")} \`<formato>\``,
    `   └ reply/anexo na mídia · png, jpg, webp, gif, mp4, mp3…`,
    `   └ envia preview + documento`,
    "",
    line,
    "_Dica: reply ou anexo na mídia quando o comando pedir._"
  ].join("\n");
}

export function isUrlMediaCommand(command) {
  return URL_MEDIA_COMMANDS.includes(String(command ?? "").toLowerCase());
}
