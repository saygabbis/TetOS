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
  ajuda: "help",
  help: "help",
  comandos: "help",
  commands: "help"
});

export const MEDIA_COMMANDS = Object.freeze([
  "sticker",
  "fsticker",
  "csticker",
  "toimg",
  "optimize",
  "removebg",
  "help"
]);

export function parseWhatsAppCommand(text = "", prefix = ".") {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith(prefix)) return null;
  const withoutPrefix = raw.slice(prefix.length).trim();
  if (!withoutPrefix) return null;
  const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
  const command = String(cmdRaw ?? "").toLowerCase();
  const normalized = MEDIA_COMMAND_ALIASES[command] ?? command;
  if (!MEDIA_COMMANDS.includes(normalized)) return null;
  return { command: normalized, args };
}

export function formatWhatsAppHelpText(prefix = ".") {
  const p = prefix || ".";
  const c = (name) => `${p}${name}`;
  return [
    "Comandos de mídia:",
    `${c("sticker")} - Gera figurinha a partir de imagem/vídeo/GIF (também como documento). Usa mídia da mensagem, reply ou última mídia recente. Stretch. Duração opcional: ${c("sticker")} 10s.`,
    `${c("fsticker")} - Igual, mas mantém tudo visível sem cortar (contain).`,
    `${c("csticker")} - Recorta o centro para caber na figurinha (crop).`,
    `${c("optimize")} - Comprime figurinha (reply/anexo); também ${p}otimizar.`,
    `${c("removebg")} - Remove fundo de imagem ou figurinha estática. Fundo transparente ou cor: ${c("removebg")} verde. Potência: leve, media, forte.`,
    `${c("toimg")} - Figurinha para imagem ou GIF/vídeo.`
  ].join("\n");
}
