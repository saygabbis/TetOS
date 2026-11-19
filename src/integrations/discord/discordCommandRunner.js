import { CATEGORIES, commandsInCategory, resolveCommand } from "../whatsapp/commands/commandCatalog.js";
import { formatHelp } from "../whatsapp/commands/commandHelp.js";
import { GENERAL_COMMANDS, runGeneralCommand } from "../whatsapp/commands/generalCommands.js";
import { isUrlMediaCommand } from "../whatsapp/commands/mediaCommandParser.js";
import { downloadMediaItem, mediaItemsOf } from "./discordMedia.js";
import { STYLES } from "../../core/media/linkCommandRunner.js";
import {
  imageCommandNeedsMedia,
  isImageCommand,
  pendingImageKey,
  runConfirmedImage,
  startImageCommand,
  takeImageConfirmation
} from "../../core/media/imageCommands.js";
import { splitForDiscord } from "./discordText.js";

/**
 * Comandos de ponto (.sticker, .yt, .cortar…) no Discord, pelo MESMO catálogo do zap: apelidos,
 * correção de digitação, help gerado do catálogo e os mesmos motores (Convenus, ffmpeg, IA).
 * Serve pro comando digitado e pro comando() que a IA pede conversando.
 */

export const TETO_COLOR = 0xd9304f;

/** Precisam de uma mídia do canal (anexo, reply, ou a última mídia mandada). */
export const DISCORD_MEDIA_COMMANDS = new Set([
  "sticker",
  "fsticker",
  "csticker",
  "toimg",
  "optimize",
  "removebg",
  "convert",
  "formatos",
  "transcrever",
  "ler",
  "cortar",
  "gif",
  "comprimir"
]);

/** Só existem no zap (ou aqui são slash): o que responder no lugar. */
const CHANNEL_MODES = "aqui no Discord é `/teto conversar` (entro no papo sozinha), `/teto padrao` (marcação/reply/nome) ou `/teto desligar`";
export const DISCORD_ELSEWHERE = Object.freeze({
  "teto-ativar": CHANNEL_MODES,
  "teto-desativar": CHANNEL_MODES,
  "teto-grupo-ativar": CHANNEL_MODES,
  "teto-grupo-desativar": CHANNEL_MODES,
  vincular: "aqui é `/vincular`: te dou um código pra mandar no meu zap",
  desvincular: "aqui é `/desvincular`",
  repertorio: "o modo repertório de figurinhas é só no zap",
  viewunica: "isso é coisa do zap",
  gastos: "isso eu mostro só no zap"
});

/** Tratados pela conversa do canal (.tetos chama ela; .monitorarpreco tem o passo de escolher opções). */
const CONVERSATION_COMMANDS = new Set(["tetos", "monitorarpreco"]);

/** Negrito do zap (*x*) → negrito do Discord (**x**). _itálico_ e `código` valem igual nos dois. */
export function toDiscordMarkdown(text = "") {
  return String(text ?? "")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?=[^*\w]|$)/gm, "$1**$2**")
    .replace(/(^|[^~])~([^~\n]+?)~(?=[^~]|$)/gm, "$1~~$2~~");
}

const cmdLine = (cmd, p) => `› \`${p}${cmd.name}${cmd.usage ? ` ${cmd.usage}` : ""}\` — ${cmd.desc}`;

/** Help do Discord em blocos (cada um vira um embed): o que vale aqui, tirado do catálogo. */
export function formatDiscordHelpSections(prefix = ".", { isOwner = false } = {}) {
  const p = prefix || ".";
  const sections = [
    {
      title: "💬 conversar comigo",
      lines: [
        "• me marca (@Teto), responde uma mensagem minha ou me chama pelo nome — na DM é só falar",
        `• \`${p}tetos <mensagem>\` ou \`/perguntar\` me chama na hora, mesmo ocupada`,
        "• modos do canal: `/teto conversar` (entro no papo sozinha) · `/teto padrao` · `/teto desligar` · `/teto calar` · `/teto status`",
        "• `/configurar` muda a chance de eu responder · `/vincular` junta teu discord com teu zap",
        "• também dá pra pedir conversando: *\"teto, baixa esse vídeo em mp3\"*, *\"corta de 1:20 a 1:45\"*"
      ]
    }
  ];
  for (const cat of CATEGORIES) {
    if (cat.id === "ativar") continue;
    const list = commandsInCategory(cat.id, { includeOwner: isOwner }).filter((c) => !DISCORD_ELSEWHERE[c.name]);
    if (!list.length) continue;
    sections.push({ title: `${cat.emoji} ${cat.title.toLowerCase()}`, lines: list.map((c) => cmdLine(c, p)) });
  }
  sections.push({
    title: "💡 dicas",
    lines: [
      `• \`${p}help <comando>\` explica um com exemplos (ex.: \`${p}help cortar\`)`,
      "• nos de mídia: manda o arquivo junto, responde a mensagem que tem ele, ou eu pego a última mídia do canal",
      "• arquivo acima de 10 MB eu comprimo sozinha pra caber no Discord",
      `• imagem: \`${p}gerar\` sai na hora (econômico) · \`${p}gerarhd\`/\`${p}editarhd\` é o modo bom: eu digo o custo e só faço quando você responder **sim**`,
      "• slash: `/gerar` `/editar` `/baixar` `/cortar` `/gif` `/comprimir` `/converter` `/playlist` `/perfil` `/figurinha` `/removerfundo` `/falar` `/clima`",
      "• clique direito numa mensagem → Apps → **Fazer figurinha** / **Remover fundo** / **Perguntar pra Teto**"
    ]
  });
  return sections.map((s) => ({ title: s.title, description: s.lines.join("\n").slice(0, 4000) }));
}

/** Help pronto pra mandar: embeds agrupados respeitando o limite de 6000 caracteres por mensagem. */
export function discordHelpMessages(args = [], prefix = ".", { isOwner = false } = {}) {
  const topic = String(args?.[0] ?? "").trim();
  if (topic) {
    const text = toDiscordMarkdown(formatHelp([topic], prefix, { isOwner, isGroup: false }));
    return [{ embeds: [{ color: TETO_COLOR, description: text.slice(0, 4000) }] }];
  }
  const messages = [];
  let current = [];
  let size = 0;
  for (const [i, s] of formatDiscordHelpSections(prefix, { isOwner }).entries()) {
    const embed = { color: TETO_COLOR, title: i === 0 ? `✦ Teto — o que eu faço por aqui ✦\n${s.title}` : s.title, description: s.description };
    const len = embed.title.length + embed.description.length;
    if (current.length && (size + len > 5800 || current.length >= 10)) {
      messages.push({ embeds: current });
      current = [];
      size = 0;
    }
    current.push(embed);
    size += len;
  }
  if (current.length) messages.push({ embeds: current });
  return messages;
}

/** Mídia de uma mensagem do Discord (anexo/figurinha), já baixada. */
export async function mediaOfMessage(message, inboxDir) {
  const item = message ? mediaItemsOf(message)[0] : null;
  return item ? downloadMediaItem(item, inboxDir) : null;
}

/** Procura a mídia: na própria mensagem, no reply, e por fim a última mídia mandada no canal. */
export async function findChannelMedia({ message = null, channel = null, messageIds = [], inboxDir }) {
  const ch = channel ?? message?.channel ?? null;
  for (const id of messageIds.filter(Boolean)) {
    const m = await ch?.messages?.fetch?.(String(id)).catch(() => null);
    const got = await mediaOfMessage(m, inboxDir);
    if (got) return got;
  }
  if (message) {
    const own = await mediaOfMessage(message, inboxDir);
    if (own) return own;
    if (message.reference?.messageId) {
      const ref = await message.fetchReference().catch(() => null);
      const got = await mediaOfMessage(ref, inboxDir);
      if (got) return got;
    }
  }
  const recent = await ch?.messages?.fetch?.({ limit: 15 }).catch(() => null);
  const item = [...(recent?.values?.() ?? [])].map((m) => mediaItemsOf(m)[0]).find(Boolean) ?? null;
  return item ? downloadMediaItem(item, inboxDir) : null;
}

/** Manda texto longo em partes (limite de 2000 do Discord). */
async function sendText(send, text) {
  for (const part of splitForDiscord(text)) await send({ content: part });
}

/** Manda o resultado do discordMedia.run: arquivos (um por mensagem quando são vários) + texto. */
export async function sendMediaResult(send, result) {
  if (!result) return;
  if (result.error) return sendText(send, result.error);
  const files = result.files ?? [];
  const text = String(result.text ?? "").trim();
  if (!files.length) return text ? sendText(send, text) : undefined;
  if (files.length === 1) {
    const content = text.length <= 1900 ? text : "";
    await send({ ...(content ? { content } : {}), files: [{ attachment: files[0].path, name: files[0].name }] });
    if (!content && text) await sendText(send, text);
    return;
  }
  for (const f of files) {
    await send({ ...(f.label ? { content: String(f.label).slice(0, 300) } : {}), files: [{ attachment: f.path, name: f.name }] }).catch((error) =>
      send({ content: `⚠️ não consegui mandar ${f.name}: ${error?.message ?? error}` })
    );
  }
  if (text) await sendText(send, text);
}

/**
 * Roda um comando já resolvido pelo catálogo.
 * @param {object} resolved resultado de resolveCommand (kind known/corrected)
 * @param {{ runtime: any, media: any, isOwnerId: (id: string) => boolean, identityOf: (user: any) => { userId: string } }} ctx
 * @param {{ author: any, channel: any, isDM: boolean, send: (payload: object) => Promise<any>, findMedia: () => Promise<any>, quotedText?: string, fromAgent?: boolean }} io
 * @returns {Promise<{ handled: boolean, ok?: boolean, reason?: string, command?: string }>}
 */
export async function runDiscordCommand(resolved, ctx, io) {
  const { runtime, media } = ctx;
  const prefix = runtime?.defaults?.commandPrefix || ".";
  const cmd = resolved?.cmd;
  if (!cmd) return { handled: false };
  const name = cmd.name;
  const { author, channel, isDM, send } = io;
  const isOwner = Boolean(ctx.isOwnerId?.(author.id));
  const who = ctx.identityOf?.(author) ?? { userId: author.id };
  let args = resolved.args ?? [];
  const rest = String(resolved.rest ?? "").trim();

  if (CONVERSATION_COMMANDS.has(name)) {
    if (!io.fromAgent) return { handled: false };
    if (name === "monitorarpreco" && runtime?.priceWatch) {
      const say = (msg) => sendText(send, toDiscordMarkdown(msg));
      const reply = await runtime.priceWatch.command(rest, { platform: "discord", chatId: channel.id, userId: author.id, isGroup: !isDM, say });
      if (reply) await say(reply);
      return { handled: true, ok: true, command: name };
    }
    return { handled: true, ok: false, reason: "not_for_agent", command: name };
  }
  if (DISCORD_ELSEWHERE[name]) {
    if (!io.fromAgent) await send({ content: DISCORD_ELSEWHERE[name] });
    return { handled: true, ok: false, reason: "elsewhere", command: name };
  }
  if (cmd.scope === "owner" && !isOwner) {
    if (!io.fromAgent) await send({ content: "isso aí é só pra Gabbis 😛" });
    return { handled: true, ok: false, reason: "owner_only", command: name };
  }

  if (name === "help") {
    for (const payload of discordHelpMessages(args, prefix, { isOwner })) await send(payload);
    return { handled: true, ok: true, command: name };
  }
  if (name === "mente") {
    if (!runtime?.mind) return send({ content: "minha mente tá desligada por aqui" }).then(() => ({ handled: true, ok: false, command: name }));
    const text = await runtime.mind.command(rest, { isOwner, userId: who.userId });
    await sendText(send, toDiscordMarkdown(text));
    return { handled: true, ok: true, command: name };
  }
  if (name === "sentimentos") {
    if (!runtime?.mind?.feelings) return send({ content: "não tô conseguindo olhar pra dentro agora" }).then(() => ({ handled: true, ok: false, command: name }));
    const text = runtime.mind.feelings.report(rest, { viewerUserId: who.userId, isOwner });
    await sendText(send, toDiscordMarkdown(text));
    return { handled: true, ok: true, command: name };
  }

  if (GENERAL_COMMANDS.has(name)) {
    // .status: "ligada neste grupo" é coisa do zap; aqui o modo do canal aparece no /teto status.
    const rt = name === "status" ? { ...runtime, tetoActivation: null } : runtime;
    const out = await runGeneralCommand(resolved, {
      runtime: rt,
      prefix,
      isGroup: !isDM,
      isOwner,
      userId: who.userId,
      chatId: `discord:${channel.id}`,
      quotedText: io.quotedText ?? "",
      receivedAt: Date.now()
    });
    if (out?.voice?.audio) await send({ files: [{ attachment: out.voice.audio, name: "teto.ogg" }] });
    if (out?.text) await sendText(send, toDiscordMarkdown(out.text));
    return { handled: true, ok: Boolean(out), command: name };
  }

  if (isImageCommand(name)) {
    const needs = imageCommandNeedsMedia(name);
    const input = needs ? await io.findMedia?.() : null;
    if (needs && !input) {
      await send({ content: `pra \`${prefix}${name}\` eu preciso de uma imagem: manda junto, ou responde a mensagem que tem ela 🙏` });
      return { handled: true, ok: false, reason: "no_media", command: name };
    }
    await channel?.sendTyping?.().catch(() => {});
    const r = await startImageCommand(name, args, {
      service: runtime?.imageGenerationService,
      isOwner,
      images: input ? [input] : [],
      pendingKey: pendingImageKey({ platform: "discord", chatId: channel.id, userId: author.id }),
      userId: who.userId,
      prefix,
      style: STYLES.discord,
      notify: (text) => send({ content: String(text).slice(0, 1990) }).catch(() => {})
    });
    await sendImageOutcome(send, r);
    return { handled: true, ok: Boolean(r.result || r.pending), command: name };
  }

  const isLink = isUrlMediaCommand(name, args);
  const needsMedia = DISCORD_MEDIA_COMMANDS.has(name) && !isLink;
  if (name !== "gerar" && !isLink && !needsMedia) return { handled: true, ok: false, reason: "unsupported", command: name };

  let big = false;
  if (["sticker", "fsticker", "csticker"].includes(name) && args.some((a) => /^(grande|big|full)$/i.test(a))) {
    big = true;
    args = args.filter((a) => !/^(grande|big|full)$/i.test(a));
  }
  let input = null;
  if (needsMedia) {
    input = await io.findMedia?.();
    if (!input) {
      await send({ content: `pra \`${prefix}${name}\` eu preciso de uma mídia: manda junto, ou responde a mensagem que tem ela 🙏` });
      return { handled: true, ok: false, reason: "no_media", command: name };
    }
  }
  await channel?.sendTyping?.().catch(() => {});
  const notify = (text) => send({ content: String(text).slice(0, 1990) }).catch(() => {});
  const result = await media
    .run(name, args, { input, userId: author.id, big, notify })
    .catch((error) => ({ error: `deu ruim: ${error?.message ?? error}` }));
  await sendMediaResult(send, result);
  return { handled: true, ok: !result?.error, command: name };
}

/** Manda o resultado de um comando de imagem (imagem + legenda, ou só o texto). */
export async function sendImageOutcome(send, r) {
  if (r?.result?.filePath) {
    await send({ content: String(r.caption ?? "✅ prontinho").slice(0, 1990), files: [{ attachment: r.result.filePath, name: "teto-imagem.png" }] });
  } else if (r?.text) {
    await sendText(send, r.text);
  }
}

/**
 * "sim"/"não" pra um pedido do modo bom pendente nesse canal. true = era isso (já respondeu).
 * @param {{ runtime: any, channel: any, authorId: string, userId?: string, text: string, send?: (payload: object) => Promise<any> }} p
 */
export async function handleDiscordImageConfirmation({ runtime, channel, authorId, userId = null, text, send = null }) {
  const service = runtime?.imageGenerationService;
  if (!service?.pending || !text) return false;
  const answer = takeImageConfirmation(text, { service, pendingKey: pendingImageKey({ platform: "discord", chatId: channel.id, userId: authorId }) });
  if (!answer) return false;
  const out = send ?? ((payload) => channel.send({ ...payload, allowedMentions: { parse: [] } }));
  if (answer.cancelled) {
    await out({ content: answer.text });
    return true;
  }
  void (async () => {
    await channel?.sendTyping?.().catch(() => {});
    const r = await runConfirmedImage(answer.plan, {
      service,
      userId: userId ?? authorId,
      style: STYLES.discord,
      notify: (t) => out({ content: t }).catch(() => {})
    });
    await sendImageOutcome(out, r);
  })().catch((error) => out({ content: `deu ruim: ${error?.message ?? error}` }).catch(() => {}));
  return true;
}

/** Comando que a IA pediu conversando (comando(".mp3 <link>")) — mesmo caminho do digitado. */
export function resolveDiscordAgentCommand(text = "", prefix = ".") {
  const p = prefix || ".";
  let raw = String(text ?? "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (raw.startsWith("/")) raw = raw.slice(1);
  if (!raw.startsWith(p)) raw = `${p}${raw}`;
  const resolved = resolveCommand(raw, p);
  return resolved?.cmd && ["known", "corrected"].includes(resolved.kind) ? resolved : null;
}
