import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import { handleIncomingMessage } from "../../app/createRuntime.js";
import { detectPlatform } from "../../core/media/urlPlatformDetect.js";
import { parseWhatsAppCommand } from "../whatsapp/commands/mediaCommandParser.js";
import { downloadMediaItem, mediaItemsOf } from "./discordMedia.js";
import { placeLabel, readableContent } from "./discordText.js";

/**
 * Comandos da Teto no Discord: os do zap portados (figurinha, remover fundo, downloads, gerar imagem,
 * converter, pergunta pontual) + os que só fazem sentido aqui (conversa livre no canal, vincular conta,
 * status, memória, lembretes, falar, clima). Também aceita os comandos de ponto do zap (.sticker etc.).
 */

const TETO_COLOR = 0xd9304f;

const attachmentOpt = (o, desc = "imagem, gif ou vídeo") => o.setName("arquivo").setDescription(desc).setRequired(true);

export function buildCommandDefinitions() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("teto")
      .setDescription("Coisas da Teto neste canal")
      .addSubcommand((s) => s.setName("conversar").setDescription("Liga a conversa livre: ela participa do papo do canal sem precisar ser marcada"))
      .addSubcommand((s) => s.setName("parar").setDescription("Desliga a conversa livre (volta a responder só quando marcam ou dão reply)"))
      .addSubcommand((s) =>
        s
          .setName("calar")
          .setDescription("Ela fica quieta neste canal por um tempo")
          .addIntegerOption((o) => o.setName("minutos").setDescription("Quanto tempo (padrão 10)").setMinValue(1).setMaxValue(1440))
      )
      .addSubcommand((s) => s.setName("voltar").setDescription("Ela volta a falar neste canal"))
      .addSubcommand((s) => s.setName("status").setDescription("O que a Teto está fazendo agora")),
    new SlashCommandBuilder()
      .setName("perguntar")
      .setDescription("Pergunta pontual pra Teto (responde mesmo se ela estiver ocupada)")
      .addStringOption((o) => o.setName("mensagem").setDescription("O que você quer perguntar").setRequired(true).setMaxLength(1500)),
    new SlashCommandBuilder().setName("vincular").setDescription("Liga esta conta ao seu WhatsApp: ela passa a saber que é você aqui também"),
    new SlashCommandBuilder().setName("desvincular").setDescription("Desfaz o vínculo desta conta com o WhatsApp"),
    new SlashCommandBuilder().setName("memoria").setDescription("O que a Teto lembra de você (só você vê)"),
    new SlashCommandBuilder().setName("lembretes").setDescription("Seus lembretes pendentes (só você vê)"),
    new SlashCommandBuilder()
      .setName("figurinha")
      .setDescription("Transforma imagem, gif ou vídeo em figurinha")
      .addAttachmentOption((o) => attachmentOpt(o))
      .addStringOption((o) =>
        o
          .setName("modo")
          .setDescription("Como encaixar")
          .addChoices({ name: "esticar (padrão)", value: "sticker" }, { name: "inteira, sem cortar", value: "fsticker" }, { name: "recortar o centro", value: "csticker" })
      )
      .addStringOption((o) => o.setName("duracao").setDescription("Gif/vídeo: até quantos segundos (ex.: 5s)")),
    new SlashCommandBuilder()
      .setName("removerfundo")
      .setDescription("Remove o fundo de uma imagem")
      .addAttachmentOption((o) => attachmentOpt(o, "a imagem"))
      .addStringOption((o) => o.setName("cor").setDescription("Cor do fundo novo (ex.: verde, #ff0000) — vazio = transparente"))
      .addStringOption((o) =>
        o.setName("forca").setDescription("Potência do recorte").addChoices({ name: "leve", value: "leve" }, { name: "média", value: "media" }, { name: "forte", value: "forte" })
      ),
    new SlashCommandBuilder()
      .setName("paraimagem")
      .setDescription("Figurinha (webp) → imagem ou gif")
      .addAttachmentOption((o) => attachmentOpt(o, "a figurinha")),
    new SlashCommandBuilder()
      .setName("converter")
      .setDescription("Converte um arquivo de mídia")
      .addAttachmentOption((o) => attachmentOpt(o, "o arquivo"))
      .addStringOption((o) => o.setName("formato").setDescription("png, jpg, webp, gif, mp4, mp3…").setRequired(true)),
    new SlashCommandBuilder()
      .setName("baixar")
      .setDescription("Baixa vídeo/áudio/foto de um link (YouTube, X, Insta, TikTok, Reddit…)")
      .addStringOption((o) => o.setName("link").setDescription("O link").setRequired(true))
      .addStringOption((o) =>
        o.setName("formato").setDescription("O que baixar").addChoices({ name: "vídeo (mp4)", value: "mp4" }, { name: "áudio (mp3)", value: "mp3" }, { name: "post/fotos", value: "post" })
      )
      .addStringOption((o) =>
        o.setName("qualidade").setDescription("Qualidade").addChoices({ name: "máxima", value: "full" }, { name: "média", value: "mid" }, { name: "baixa (arquivo menor)", value: "low" })
      ),
    new SlashCommandBuilder()
      .setName("thumb")
      .setDescription("Pega a capa (thumbnail) de um vídeo do YouTube")
      .addStringOption((o) => o.setName("link").setDescription("Link do YouTube").setRequired(true)),
    new SlashCommandBuilder()
      .setName("gerar")
      .setDescription("A Teto gera uma imagem por IA")
      .addStringOption((o) => o.setName("descricao").setDescription("O que desenhar").setRequired(true).setMaxLength(500)),
    new SlashCommandBuilder()
      .setName("falar")
      .setDescription("A Teto fala o texto num áudio")
      .addStringOption((o) => o.setName("texto").setDescription("O que ela vai falar").setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder()
      .setName("clima")
      .setDescription("Previsão do tempo")
      .addStringOption((o) => o.setName("cidade").setDescription("Cidade (padrão: São Paulo)")),
    new SlashCommandBuilder().setName("ajuda").setDescription("Tudo que a Teto faz por aqui"),
    new ContextMenuCommandBuilder().setName("Fazer figurinha").setType(ApplicationCommandType.Message),
    new ContextMenuCommandBuilder().setName("Remover fundo").setType(ApplicationCommandType.Message),
    new ContextMenuCommandBuilder().setName("Perguntar pra Teto").setType(ApplicationCommandType.Message)
  ];
  return cmds.map((c) => c.toJSON());
}

export function formatDiscordHelp(prefix = ".") {
  return [
    "**Conversar comigo**",
    "• me marca (@Teto) ou responde uma mensagem minha — no privado é só falar",
    "• `/teto conversar` liga a conversa livre no canal (eu entro no papo sem ser marcada); `/teto parar` desliga",
    "• `/teto calar` me deixa quieta um tempo; `/teto voltar` · `/teto status` mostra o que tô fazendo",
    "• `/perguntar` pergunta pontual, respondo mesmo ocupada",
    "",
    "**Conta**",
    "• `/vincular` liga teu discord ao teu zap (lembro de você nos dois) · `/desvincular`",
    "• `/memoria` o que eu lembro de você · `/lembretes` teus lembretes (pede no papo: \"me lembra às 15h de…\")",
    "",
    "**Mídia**",
    "• `/figurinha` · `/removerfundo` · `/paraimagem` · `/converter` · `/gerar` · `/falar`",
    "• `/baixar` link do YouTube, X, Insta, TikTok, Reddit, Facebook… · `/thumb`",
    "• clique direito numa mensagem → Apps → **Fazer figurinha** / **Remover fundo** / **Perguntar pra Teto**",
    `• os comandos do zap também valem: \`${prefix}sticker\`, \`${prefix}removebg\`, \`${prefix}toimg\`, \`${prefix}yt <link> mp3\`… (com anexo ou em reply)`,
    "",
    "**Outros** · `/clima`"
  ].join("\n");
}

const canManage = (interaction, ctx) =>
  ctx.isOwnerId(interaction.user.id) || Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageChannels));

async function sendResult(interaction, result) {
  if (result.error || (!result.files?.length && result.text)) {
    return interaction.editReply({ content: result.error ?? result.text });
  }
  return interaction.editReply({ files: (result.files ?? []).map((f) => ({ attachment: f.path, name: f.name })) });
}

/** Pergunta pontual (igual ao .tetos do zap): passa por cima de ocupada/dormindo. */
async function askOnce(runtime, ctx, interaction, question, { quoted = null } = {}) {
  const who = ctx.identityOf(interaction.user);
  const channelId = `discord:${interaction.channelId}`;
  const isDM = !interaction.guildId;
  const out = await handleIncomingMessage(runtime, {
    message: question,
    userId: who.userId,
    sessionId: isDM ? `discord-dm:${interaction.user.id}` : `discord-ch:${interaction.channelId}:${interaction.user.id}`,
    channelId,
    isGroup: !isDM,
    participants: [who.userId],
    isDirectMention: true,
    quotedMessage: quoted?.text ?? null,
    quotedMessageId: quoted?.id ?? null,
    isReply: Boolean(quoted),
    pushName: interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username,
    participantId: isDM ? null : who.userId,
    isOwner: who.isOwner,
    tetosCommand: true,
    platform: "discord",
    platformPlace: placeLabel(interaction.channel)
  });
  const texts = (out?.replies?.actions ?? []).filter((a) => a.type === "message").map((a) => a.text);
  return (texts.length ? texts : out?.replies ?? []).join("\n").trim() || "…não sei o que dizer kkk";
}

export async function handleInteraction(interaction, ctx) {
  const { runtime, media, state } = ctx;
  if (interaction.isMessageContextMenuCommand()) {
    const target = interaction.targetMessage;
    if (interaction.commandName === "Perguntar pra Teto") {
      await interaction.deferReply();
      const quoted = { id: target.id, text: readableContent(target, { botId: interaction.client.user.id }) || "[anexo]" };
      const answer = await askOnce(runtime, ctx, interaction, `o que você acha disso? "${quoted.text.slice(0, 600)}"`, { quoted });
      return interaction.editReply({ content: answer.slice(0, 1990), allowedMentions: { parse: [] } });
    }
    const item = mediaItemsOf(target)[0];
    if (!item) return interaction.reply({ content: "essa mensagem não tem imagem/vídeo", flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const input = await downloadMediaItem(item, media.inboxDir);
    const command = interaction.commandName === "Fazer figurinha" ? "sticker" : "removebg";
    return sendResult(interaction, await media.run(command, [], { input, userId: interaction.user.id }));
  }
  if (!interaction.isChatInputCommand()) return;

  const name = interaction.commandName;
  const opt = interaction.options;
  const eph = { flags: MessageFlags.Ephemeral };

  if (name === "ajuda") {
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(TETO_COLOR).setTitle("o que eu faço por aqui").setDescription(formatDiscordHelp(runtime.defaults.commandPrefix))], ...eph });
  }

  if (name === "teto") {
    const sub = opt.getSubcommand();
    const channelId = interaction.channelId;
    if (sub === "status") {
      const life = runtime.brainOrchestrator?.life;
      const snap = life?.getSnapshot?.();
      const mood = life?.mood?.();
      const lines = life?.promptLines?.({ isGroup: true }) ?? [];
      const agora = lines.find((l) => l.startsWith("Agora:")) ?? (snap ? `Agora: ${snap.currentActivity}` : "não sei kkk");
      const extra = [];
      if (state.isFreeChat(channelId)) extra.push("conversa livre ligada neste canal");
      if (state.mutedUntil(channelId)) extra.push(`quieta aqui até <t:${Math.round(state.mutedUntil(channelId) / 1000)}:t>`);
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(TETO_COLOR)
            .setTitle("Teto agora")
            .setDescription([agora.replace(/^Agora: /, ""), mood ? `humor: ${mood.mood}` : null, ...extra].filter(Boolean).join("\n"))
        ]
      });
    }
    if (!interaction.guildId) return interaction.reply({ content: "isso é coisa de servidor — aqui no privado eu já converso normal", ...eph });
    if (!canManage(interaction, ctx)) return interaction.reply({ content: "só quem pode gerenciar o canal mexe nisso", ...eph });
    if (sub === "conversar") {
      state.setFreeChat(channelId, true, { by: interaction.user.id, guildId: interaction.guildId, name: interaction.channel?.name ?? null });
      state.unmute(channelId);
      return interaction.reply("oba, conversa livre ligada aqui! vou entrar no papo de vez em quando sem precisar me marcar 👀");
    }
    if (sub === "parar") {
      state.setFreeChat(channelId, false);
      return interaction.reply("tá bom, aqui eu só respondo quando me marcarem ou derem reply");
    }
    if (sub === "calar") {
      const minutes = opt.getInteger("minutos") ?? 10;
      state.mute(channelId, minutes * 60_000);
      return interaction.reply(`ok… fico quieta aqui por ${minutes} min 🤐`);
    }
    if (sub === "voltar") {
      state.unmute(channelId);
      return interaction.reply("voltei!!");
    }
  }

  if (name === "perguntar") {
    await interaction.deferReply();
    const answer = await askOnce(runtime, ctx, interaction, opt.getString("mensagem", true));
    return interaction.editReply({ content: answer.slice(0, 1990), allowedMentions: { parse: [] } });
  }

  if (name === "vincular") {
    const current = runtime.identityLinks.get(interaction.user.id);
    const { code } = runtime.identityLinks.createCode({ discordId: interaction.user.id, discordName: interaction.user.username });
    const header = current ? "essa conta já tá vinculada — se mandar o código de outro zap, troca o vínculo.\n\n" : "";
    return interaction.reply({
      content: `${header}manda isso pra mim no **privado do WhatsApp** nos próximos 10 min:\n\`\`\`\n${runtime.defaults.commandPrefix}vincular ${code}\n\`\`\`\naí eu fico sabendo que você aqui é você lá 💕`,
      ...eph
    });
  }
  if (name === "desvincular") {
    const ok = runtime.identityLinks.unlink(interaction.user.id);
    return interaction.reply({ content: ok ? "desvinculado. aqui eu não vou mais misturar com o zap" : "essa conta não tava vinculada", ...eph });
  }

  if (name === "memoria") {
    const who = ctx.identityOf(interaction.user);
    const lines = runtime.peopleMemory?.promptLines?.(who.userId, "direct", { name: interaction.user.globalName ?? interaction.user.username }) ?? [];
    const body = lines.slice(1, -1).join("\n").trim();
    const hint = who.linked ? "" : "\n\n(essa conta não tá vinculada ao zap — `/vincular` junta as memórias)";
    return interaction.reply({ content: `${body || "ainda não tenho muita coisa anotada sobre você kkk"}${hint}`.slice(0, 1990), ...eph });
  }

  if (name === "lembretes") {
    const who = ctx.identityOf(interaction.user);
    const list = (runtime.reminders?.list?.(who.userId) ?? []).filter((r) => !r.done && !r.deliveredAt);
    const fmt = (r) => `• ${r.text}${r.dueAt ? ` — <t:${Math.round(Date.parse(r.dueAt) / 1000)}:f>` : ""}`;
    return interaction.reply({ content: list.length ? list.map(fmt).join("\n").slice(0, 1990) : "nenhum lembrete pendente. pede no papo: \"me lembra às 15h de…\"", ...eph });
  }

  if (name === "clima") {
    await interaction.deferReply();
    const f = await runtime.weather?.forecast?.(opt.getString("cidade") ?? "São Paulo").catch(() => null);
    if (!f) return interaction.editReply("não achei essa cidade 😕");
    const [today, next] = f.days;
    const day = (label, d) => (d ? `**${label}:** ${d.min}–${d.max}°C, ${d.sky}${d.rainChance != null ? ` · ${d.rainChance}% de chuva` : ""}` : null);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(TETO_COLOR)
          .setTitle(f.place)
          .setDescription([`**Agora:** ${f.now.temp}°C (sensação ${f.now.feels}°C), ${f.now.sky}`, day("Hoje", today), day("Amanhã", next)].filter(Boolean).join("\n"))
      ]
    });
  }

  if (name === "falar") {
    await interaction.deferReply();
    const note = await runtime.voiceNotes.synthesize(opt.getString("texto", true)).catch(() => null);
    if (!note) return interaction.editReply("não consegui gravar agora 😭");
    return interaction.editReply({ files: [{ attachment: note.audio, name: "teto.ogg" }] });
  }

  const userId = interaction.user.id;
  if (name === "gerar") {
    await interaction.deferReply();
    return sendResult(interaction, await media.run("gerar", [opt.getString("descricao", true)], { userId }));
  }
  if (name === "baixar" || name === "thumb") {
    await interaction.deferReply();
    const link = opt.getString("link", true);
    const platform = detectPlatform(link);
    const command = name === "thumb" ? "thumbnail" : platform === "generic" ? "download" : platform;
    const args = [link, opt.getString("formato"), opt.getString("qualidade")].filter(Boolean);
    return sendResult(interaction, await media.run(command, args, { userId }));
  }

  const attachment = opt.getAttachment?.("arquivo");
  if (attachment) {
    await interaction.deferReply();
    const input = await downloadMediaItem({ id: attachment.id, url: attachment.url, name: attachment.name, contentType: attachment.contentType, size: attachment.size }, media.inboxDir);
    if (name === "figurinha") {
      return sendResult(interaction, await media.run(opt.getString("modo") ?? "sticker", [opt.getString("duracao")].filter(Boolean), { input, userId }));
    }
    if (name === "removerfundo") {
      return sendResult(interaction, await media.run("removebg", [opt.getString("cor"), opt.getString("forca")].filter(Boolean), { input, userId }));
    }
    if (name === "paraimagem") return sendResult(interaction, await media.run("toimg", [], { input, userId }));
    if (name === "converter") return sendResult(interaction, await media.run("convert", [opt.getString("formato", true)], { input, userId }));
  }
}

/** Comandos de ponto do zap (.sticker, .removebg, .yt …) numa mensagem do Discord. true = tratou. */
export async function handlePrefixCommand(message, ctx) {
  const { runtime, media } = ctx;
  const prefix = runtime.defaults.commandPrefix || ".";
  const text = readableContent(message, { botId: message.client.user.id });
  const parsed = parseWhatsAppCommand(text, prefix);
  if (!parsed) return false;
  if (parsed.command === "help") {
    await message.reply({ embeds: [new EmbedBuilder().setColor(TETO_COLOR).setTitle("o que eu faço por aqui").setDescription(formatDiscordHelp(prefix))], allowedMentions: { repliedUser: false } });
    return true;
  }
  if (parsed.command === "repertorio") return false;
  await message.channel.sendTyping().catch(() => {});
  let input = null;
  const needsMedia = !["gerar", "youtube", "twitter", "instagram", "reddit", "tiktok", "facebook", "download", "thumbnail"].includes(parsed.command);
  if (needsMedia) {
    let item = mediaItemsOf(message)[0];
    if (!item && message.reference?.messageId) {
      const ref = await message.fetchReference().catch(() => null);
      item = ref ? mediaItemsOf(ref)[0] : null;
    }
    if (!item) {
      // Igual ao zap: sem anexo nem reply, pega a última mídia do canal.
      const recent = await message.channel.messages.fetch({ limit: 15 }).catch(() => null);
      item = [...(recent?.values() ?? [])].map((m) => mediaItemsOf(m)[0]).find(Boolean) ?? null;
    }
    input = item ? await downloadMediaItem(item, media.inboxDir) : null;
  }
  const result = await media.run(parsed.command, parsed.args, { input, userId: message.author.id }).catch((error) => ({ error: `deu ruim: ${error?.message ?? error}` }));
  const reply = (payload) => message.reply({ ...payload, allowedMentions: { repliedUser: false } });
  if (result.files?.length) await reply({ files: result.files.map((f) => ({ attachment: f.path, name: f.name })) }).catch(async (error) => reply({ content: `não consegui mandar o arquivo (${error?.message ?? error})` }));
  else await reply({ content: result.error ?? result.text ?? "pronto" });
  return true;
}
