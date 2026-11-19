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
import { findCommand, resolveCommand } from "../whatsapp/commands/commandCatalog.js";
import { downloadMediaItem, mediaItemsOf } from "./discordMedia.js";
import { placeLabel, readableContent } from "./discordText.js";
import { MODE_LABEL, formatRate, polishDiscordActions } from "./discordPolicy.js";
import { TETO_COLOR, discordHelpMessages, findChannelMedia, formatDiscordHelpSections, runDiscordCommand } from "./discordCommandRunner.js";

/**
 * Comandos da Teto no Discord: os do zap portados (figurinha, remover fundo, downloads, cortar, gif,
 * comprimir, converter, playlist, perfil, gerar imagem, pergunta pontual) + os que só fazem sentido aqui
 * (conversa livre no canal, vincular conta, status, memória, lembretes). Os comandos de ponto do zap
 * (.sticker, .yt, .cortar…) valem igual, pelo mesmo catálogo (apelidos e correção de digitação).
 */

const attachmentOpt = (o, desc = "imagem, gif ou vídeo") => o.setName("arquivo").setDescription(desc).setRequired(true);
const optionalFile = (o, desc) => o.setName("arquivo").setDescription(desc);
const optionalLink = (o, desc = "Link (ou mande um arquivo)") => o.setName("link").setDescription(desc);
const timeOpt = (o, name, desc, required = false) => o.setName(name).setDescription(desc).setRequired(required).setMaxLength(12);

export function buildCommandDefinitions() {
  const cmds = [
    new SlashCommandBuilder()
      .setName("teto")
      .setDescription("Coisas da Teto neste canal")
      .addSubcommand((s) => s.setName("conversar").setDescription("Modo livre: ela entra no papo do canal sozinha, no ritmo do /configurar"))
      .addSubcommand((s) => s.setName("padrao").setDescription("Modo padrão: responde quando marcam, dão reply ou chamam pelo nome"))
      .addSubcommand((s) => s.setName("desligar").setDescription("Desliga: neste canal ela só responde a comando (/perguntar, .tetos)"))
      .addSubcommand((s) =>
        s
          .setName("calar")
          .setDescription("Ela fica quieta neste canal por um tempo")
          .addIntegerOption((o) => o.setName("minutos").setDescription("Quanto tempo (padrão 10)").setMinValue(1).setMaxValue(1440))
      )
      .addSubcommand((s) => s.setName("voltar").setDescription("Ela volta a falar neste canal"))
      .addSubcommand((s) => s.setName("status").setDescription("O que a Teto está fazendo agora")),
    new SlashCommandBuilder()
      .setName("configurar")
      .setDescription("Como a Teto se comporta neste canal")
      .addIntegerOption((o) => o.setName("respostas").setDescription("Quantas respostas… (vale pra mensagem e/ou marcação)").setMinValue(1).setMaxValue(100))
      .addIntegerOption((o) => o.setName("mensagem").setDescription("…a cada quantas mensagens (modo livre: chance de entrar no papo sozinha)").setMinValue(1).setMaxValue(100))
      .addIntegerOption((o) => o.setName("marcação").setDescription("…a cada quantas marcações/replies/chamadas pelo nome").setMinValue(1).setMaxValue(100))
      .addStringOption((o) =>
        o
          .setName("modo")
          .setDescription("off = só comando · padrão = marcação/reply/nome · livre = entra no papo sozinha")
          .addChoices({ name: "livre", value: "livre" }, { name: "padrão", value: "padrao" }, { name: "off", value: "off" })
      )
      .addBooleanOption((o) => o.setName("reset").setDescription("Volta este canal pro padrão (modo padrão, chances padrão)")),
    new SlashCommandBuilder()
      .setName("perguntar")
      .setDescription("Pergunta pontual pra Teto (responde mesmo se ela estiver ocupada)")
      .addStringOption((o) => o.setName("mensagem").setDescription("O que você quer perguntar").setRequired(true).setMaxLength(1500)),
    new SlashCommandBuilder().setName("vincular").setDescription("Liga esta conta ao seu WhatsApp: ela passa a saber que é você aqui também"),
    new SlashCommandBuilder().setName("desvincular").setDescription("Desfaz o vínculo desta conta com o WhatsApp"),
    new SlashCommandBuilder().setName("memoria").setDescription("O que a Teto lembra de você (só você vê)"),
    new SlashCommandBuilder().setName("lembretes").setDescription("Seus lembretes pendentes (só você vê)"),
    new SlashCommandBuilder()
      .setName("mente")
      .setDescription("O que a Teto estudou, aprendeu e mudou nela mesma (comandos só da dona)")
      .addStringOption((o) =>
        o
          .setName("comando")
          .setDescription("status, estudar, licoes, pedidos, autorizar <id>, recusar <id>, ver <id>, aplicar, desfazer <id>…")
          .setMaxLength(200)
      ),
    new SlashCommandBuilder()
      .setName("sentimentos")
      .setDescription("Como a Teto está se sentindo agora, por quê, e como reagiu a algo (só você vê)")
      .addStringOption((o) => o.setName("sobre").setDescription('"historico" (mudanças de humor) ou um assunto/pessoa').setMaxLength(100)),
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
      .addStringOption((o) => o.setName("duracao").setDescription("Gif/vídeo: até quantos segundos (ex.: 5s)"))
      .addStringOption((o) =>
        o.setName("tamanho").setDescription("emoji (padrão) ou grande, pra salvar o arquivo").addChoices({ name: "emoji", value: "emoji" }, { name: "grande", value: "grande" })
      ),
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
      .setDescription("Converte um arquivo (vídeo, áudio, imagem, documento…) pra outro formato")
      .addAttachmentOption((o) => attachmentOpt(o, "o arquivo"))
      .addStringOption((o) => o.setName("formato").setDescription("mp3, mp4, png, jpg, webp, gif, pdf, wav, flac… (vazio = te digo as opções)")),
    new SlashCommandBuilder()
      .setName("baixar")
      .setDescription("Baixa vídeo, áudio ou fotos de um link (YouTube, X, Insta, TikTok, Reddit, Twitch…)")
      .addStringOption((o) => o.setName("link").setDescription("O link").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("formato")
          .setDescription("O que baixar (padrão: vídeo)")
          .addChoices(
            { name: "vídeo (mp4)", value: "mp4" },
            { name: "áudio (mp3)", value: "mp3" },
            { name: "áudio sem perda (wav)", value: "wav" },
            { name: "gif", value: "gif" },
            { name: "post/fotos", value: "post" }
          )
      )
      .addStringOption((o) =>
        o
          .setName("qualidade")
          .setDescription("Qualidade (padrão: máxima)")
          .addChoices(
            { name: "máxima", value: "full" },
            { name: "1080p", value: "1080" },
            { name: "720p", value: "720" },
            { name: "480p", value: "480" },
            { name: "360p", value: "360" },
            { name: "baixa (arquivo menor)", value: "low" }
          )
      )
      .addStringOption((o) => timeOpt(o, "inicio", "Só um trecho: começa em (ex.: 1:20)"))
      .addStringOption((o) => timeOpt(o, "fim", "Só um trecho: termina em (ex.: 1:45)"))
      .addStringOption((o) => o.setName("legenda").setDescription("Grava a legenda no vídeo, nesse idioma (ex.: pt, en)").setMaxLength(8))
      .addNumberOption((o) => o.setName("tamanho").setDescription("Tamanho máximo em MB (comprime se passar)").setMinValue(1).setMaxValue(500)),
    new SlashCommandBuilder()
      .setName("cortar")
      .setDescription("Corta um trecho de vídeo/áudio (de um link ou de um arquivo)")
      .addStringOption((o) => timeOpt(o, "inicio", "Começa em (ex.: 1:20 ou 80s)", true))
      .addStringOption((o) => timeOpt(o, "fim", "Termina em (ex.: 1:45)", true))
      .addStringOption((o) => optionalLink(o))
      .addAttachmentOption((o) => optionalFile(o, "Vídeo ou áudio (ou use um link)"))
      .addStringOption((o) => o.setName("formato").setDescription("Sai como").addChoices({ name: "vídeo (mp4)", value: "mp4" }, { name: "áudio (mp3)", value: "mp3" })),
    new SlashCommandBuilder()
      .setName("gif")
      .setDescription("Faz um GIF de um trecho de vídeo (link ou arquivo)")
      .addStringOption((o) => optionalLink(o))
      .addAttachmentOption((o) => optionalFile(o, "Vídeo (ou use um link)"))
      .addStringOption((o) => timeOpt(o, "inicio", "Começa em (padrão: 0:00)"))
      .addStringOption((o) => timeOpt(o, "fim", "Termina em (padrão: alguns segundos depois; máx. 60s)"))
      .addIntegerOption((o) => o.setName("fps").setDescription("Quadros por segundo").addChoices({ name: "10", value: 10 }, { name: "15 (padrão)", value: 15 }, { name: "24", value: 24 }))
      .addIntegerOption((o) =>
        o.setName("largura").setDescription("Largura em px").addChoices({ name: "320", value: 320 }, { name: "480 (padrão)", value: 480 }, { name: "640", value: 640 })
      ),
    new SlashCommandBuilder()
      .setName("comprimir")
      .setDescription("Deixa um vídeo/áudio/imagem/PDF menor (até X MB)")
      .addAttachmentOption((o) => optionalFile(o, "O arquivo (ou use um link)"))
      .addStringOption((o) => optionalLink(o, "Link de vídeo pra baixar já comprimido"))
      .addNumberOption((o) => o.setName("mb").setDescription("Tamanho alvo em MB (padrão: cabe no Discord)").setMinValue(0.1).setMaxValue(500)),
    new SlashCommandBuilder()
      .setName("playlist")
      .setDescription("Lista ou baixa faixas de uma playlist/álbum")
      .addStringOption((o) => o.setName("link").setDescription("Link da playlist/álbum").setRequired(true))
      .addStringOption((o) => o.setName("itens").setDescription("Quais: 1-5, 2,4,7 ou todas (vazio = só lista)").setMaxLength(60))
      .addStringOption((o) => o.setName("formato").setDescription("Padrão: mp3").addChoices({ name: "áudio (mp3)", value: "mp3" }, { name: "vídeo (mp4)", value: "mp4" })),
    new SlashCommandBuilder()
      .setName("perfil")
      .setDescription("Perfil/canal de um link: resumo, foto, capa ou os últimos posts")
      .addStringOption((o) => o.setName("link").setDescription("Link do perfil/canal").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("pegar")
          .setDescription("O que pegar (padrão: resumo)")
          .addChoices({ name: "resumo", value: "info" }, { name: "foto de perfil", value: "foto" }, { name: "capa/banner", value: "capa" })
      )
      .addStringOption((o) => o.setName("secao").setDescription("Baixa posts de uma seção (ex.: videos, shorts, posts)").setMaxLength(30))
      .addIntegerOption((o) => o.setName("quantidade").setDescription("Quantos posts (até 10)").setMinValue(1).setMaxValue(10)),
    new SlashCommandBuilder()
      .setName("linkinfo")
      .setDescription("O que tem num link (título, duração, qualidades, legendas) sem baixar")
      .addStringOption((o) => o.setName("link").setDescription("O link").setRequired(true)),
    new SlashCommandBuilder()
      .setName("legenda")
      .setDescription("Baixa a legenda (.srt) de um vídeo")
      .addStringOption((o) => o.setName("link").setDescription("O link").setRequired(true))
      .addStringOption((o) => o.setName("idioma").setDescription("pt, en, es… (padrão: pt)").setMaxLength(8)),
    new SlashCommandBuilder()
      .setName("transcrever")
      .setDescription("Passa um áudio/vídeo pra texto")
      .addAttachmentOption((o) => attachmentOpt(o, "o áudio ou vídeo")),
    new SlashCommandBuilder()
      .setName("ler")
      .setDescription("Descreve uma imagem e lê o texto dela")
      .addAttachmentOption((o) => attachmentOpt(o, "a imagem")),
    new SlashCommandBuilder()
      .setName("thumb")
      .setDescription("Pega a capa (thumbnail) de um vídeo")
      .addStringOption((o) => o.setName("link").setDescription("Link do vídeo").setRequired(true)),
    new SlashCommandBuilder()
      .setName("gerar")
      .setDescription("A Teto gera uma imagem por IA (econômico na hora; modo bom mostra o custo e pede sim)")
      .addStringOption((o) => o.setName("descricao").setDescription("O que desenhar").setRequired(true).setMaxLength(1500))
      .addStringOption((o) =>
        o
          .setName("modo")
          .setDescription("econômico (padrão) ou bom (GPT Image 2.6 Sunburst, pede confirmação)")
          .addChoices({ name: "econômico", value: "eco" }, { name: "bom (alta)", value: "alta" }, { name: "bom (ultra)", value: "ultra" }, { name: "bom (máxima)", value: "max" })
      )
      .addStringOption((o) =>
        o
          .setName("formato")
          .setDescription("Proporção (padrão: quadrada)")
          .addChoices(
            { name: "quadrada 1:1", value: "1:1" },
            { name: "paisagem 3:2", value: "3:2" },
            { name: "retrato 2:3", value: "2:3" },
            { name: "wide 16:9", value: "16:9" },
            { name: "celular 9:16", value: "9:16" }
          )
      )
      .addBooleanOption((o) => o.setName("2k").setDescription("Resolução maior (só no modo bom)")),
    new SlashCommandBuilder()
      .setName("editar")
      .setDescription("Edita uma imagem com IA (trocar fundo, estilo, tirar/colocar coisas…)")
      .addStringOption((o) => o.setName("pedido").setDescription("O que mudar").setRequired(true).setMaxLength(1500))
      .addAttachmentOption((o) => optionalFile(o, "A imagem (vazio = a última imagem do canal)"))
      .addStringOption((o) =>
        o
          .setName("modo")
          .setDescription("econômico (padrão) ou bom (pede confirmação)")
          .addChoices({ name: "econômico", value: "eco" }, { name: "bom (alta)", value: "alta" }, { name: "bom (ultra)", value: "ultra" }, { name: "bom (máxima)", value: "max" })
      ),
    new SlashCommandBuilder()
      .setName("falar")
      .setDescription("A Teto fala o texto num áudio")
      .addStringOption((o) => o.setName("texto").setDescription("O que ela vai falar").setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder()
      .setName("clima")
      .setDescription("Previsão do tempo")
      .addStringOption((o) => o.setName("cidade").setDescription("Cidade (padrão: São Paulo)")),
    new SlashCommandBuilder()
      .setName("ajuda")
      .setDescription("Tudo que a Teto faz por aqui")
      .addStringOption((o) => o.setName("comando").setDescription("Explica um comando ou categoria (ex.: cortar, baixar)").setMaxLength(30)),
    new ContextMenuCommandBuilder().setName("Fazer figurinha").setType(ApplicationCommandType.Message),
    new ContextMenuCommandBuilder().setName("Remover fundo").setType(ApplicationCommandType.Message),
    new ContextMenuCommandBuilder().setName("Perguntar pra Teto").setType(ApplicationCommandType.Message)
  ];
  return cmds.map((c) => c.toJSON());
}

/** Help do Discord em texto corrido (gerado do catálogo). */
export function formatDiscordHelp(prefix = ".", opts = {}) {
  return formatDiscordHelpSections(prefix, opts)
    .map((s) => `**${s.title}**\n${s.description}`)
    .join("\n\n");
}

/** Slash → comando de ponto equivalente ({ command, args }), pra rodar pelo mesmo caminho. */
export function slashToCommand(name, opt) {
  const s = (key) => opt.getString?.(key) ?? null;
  const n = (key) => opt.getNumber?.(key) ?? opt.getInteger?.(key) ?? null;
  const range = (a, b) => (a && b ? [a, b] : a ? [a] : b ? ["0:00", b] : []);
  const list = (...xs) => xs.flat().filter((x) => x != null && String(x).trim() !== "").map(String);
  switch (name) {
    case "figurinha":
      return { command: s("modo") ?? "sticker", args: list(s("duracao"), s("tamanho") === "grande" ? "grande" : null) };
    case "removerfundo":
      return { command: "removebg", args: list(s("cor"), s("forca")) };
    case "paraimagem":
      return { command: "toimg", args: [] };
    case "converter":
      return { command: "convert", args: list(s("formato")) };
    case "gerar": {
      const modo = s("modo");
      const hd = Boolean(modo) && modo !== "eco";
      const big = hd && opt.getBoolean?.("2k") ? "2k" : null;
      return { command: hd ? "gerarhd" : "gerar", args: list(hd ? modo : null, s("formato"), big, s("descricao")) };
    }
    case "editar": {
      const modo = s("modo");
      const hd = Boolean(modo) && modo !== "eco";
      return { command: hd ? "editarhd" : "editar", args: list(hd ? modo : null, s("pedido")) };
    }
    case "baixar": {
      const link = s("link");
      const formato = s("formato");
      const platform = detectPlatform(link);
      const command = formato === "gif" ? "gif" : platform && platform !== "generic" && findCommand(platform) ? platform : "download";
      return {
        command,
        args: list(link, formato === "gif" ? null : formato, s("qualidade"), range(s("inicio"), s("fim")), s("legenda") ? `leg:${s("legenda")}` : null, n("tamanho") ? `${n("tamanho")}mb` : null)
      };
    }
    case "thumb":
      return { command: "thumbnail", args: list(s("link")) };
    case "cortar":
      return { command: "cortar", args: list(s("link"), s("inicio"), s("fim"), s("formato")) };
    case "gif":
      return { command: "gif", args: list(s("link"), range(s("inicio"), s("fim")), n("fps") ? `${n("fps")}fps` : null, n("largura") ? `${n("largura")}px` : null) };
    case "comprimir": {
      const mb = n("mb");
      return { command: "comprimir", args: list(s("link"), mb ? `${mb}mb` : null) };
    }
    case "playlist":
      return { command: "playlist", args: list(s("link"), s("itens")?.split(/\s+/), s("formato")) };
    case "perfil":
      return { command: "perfil", args: list(s("link"), s("pegar") && s("pegar") !== "info" ? s("pegar") : null, s("secao"), n("quantidade")) };
    case "linkinfo":
      return { command: "linkinfo", args: list(s("link")) };
    case "legenda":
      return { command: "legenda", args: list(s("link"), s("idioma")) };
    case "transcrever":
      return { command: "transcrever", args: [] };
    case "ler":
      return { command: "ler", args: [] };
    default:
      return null;
  }
}

/** Envio pela interação: a 1ª mensagem edita o "pensando…", as outras vão como follow-up. */
function interactionSender(interaction) {
  let sent = 0;
  const send = async (payload) => {
    const p = { ...payload, allowedMentions: { parse: [] } };
    sent += 1;
    return sent === 1 ? interaction.editReply(p) : interaction.followUp(p);
  };
  send.count = () => sent;
  return send;
}

/** Envio por mensagem: a 1ª responde quem pediu, as outras vão soltas no canal. */
export function messageSender(message) {
  let sent = 0;
  return async (payload) => {
    const p = { ...payload, allowedMentions: { parse: [], repliedUser: false } };
    sent += 1;
    return sent === 1 ? message.reply(p) : message.channel.send(p);
  };
}

/** Resumo da configuração do canal (resposta do /configurar). */
export function formatChannelConfig(cfg, { reset = false } = {}) {
  const lines = [`${reset ? "voltei pro padrão! " : "configurado! "}modo: **${MODE_LABEL[cfg.mode]}**`];
  if (cfg.mode === "off") {
    lines.push("aqui eu só respondo com `/perguntar` ou `.tetos`");
  } else {
    lines.push(`• marcação/reply/nome: ${formatRate(cfg.tagReplies, cfg.tagEvery)}${cfg.tagReplies >= cfg.tagEvery ? " — respondo sempre (quando tô livre)" : " de chance em cada uma"}`);
    lines.push(
      cfg.mode === "livre"
        ? `• conversa livre: ${formatRate(cfg.replies, cfg.every)} de chance em cada mensagem de entrar no papo sozinha`
        : `• conversa livre: ${formatRate(cfg.replies, cfg.every)} (só vale no modo livre)`
    );
  }
  lines.push("comando (`/perguntar`, `.tetos`) eu respondo sempre, mesmo ocupada");
  return lines.join("\n");
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
  // Igual a marcar: depois da pergunta, as próximas mensagens dela/dele no canal são respondidas na hora.
  runtime.summons?.summon?.(ctx.summonKeyOf(interaction.channelId, interaction.user.id));
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
  const actions = out?.replies?.actions ?? (out?.replies ?? []).map((text) => ({ type: "message", text }));
  // Mesmo acabamento das outras respostas: uma mensagem só e sem marcar quem perguntou.
  const replyToNames = [interaction.member?.displayName, interaction.user.globalName, interaction.user.username, ...(ctx.namesFor?.(interaction.user.id) ?? [])];
  const polished = polishDiscordActions(actions, { replyToNames, maxLines: 3, stickerAllowed: false });
  const answer = polished.find((a) => a.type === "message")?.text?.trim() || "…não sei o que dizer kkk";
  const place = placeLabel(interaction.channel) ?? "DM";
  const asker = interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
  ctx.dlog?.chat(place, asker, `/perguntar ${question}`);
  ctx.dlog?.decision(place, asker, "respondeu", "/perguntar");
  ctx.dlog?.chat(place, "Teto", answer);
  return answer;
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
    const [first, ...more] = discordHelpMessages([opt.getString("comando")].filter(Boolean), runtime.defaults.commandPrefix, { isOwner: ctx.isOwnerId(interaction.user.id) });
    await interaction.reply({ ...first, ...eph });
    for (const payload of more) await interaction.followUp({ ...payload, ...eph });
    return;
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
      if (interaction.guildId) {
        const cfg = state.channel(channelId);
        extra.push(`neste canal: ${MODE_LABEL[cfg.mode]}`);
        if (cfg.mode !== "off") extra.push(`marcações: ${formatRate(cfg.tagReplies, cfg.tagEvery)}${cfg.mode === "livre" ? ` · mensagens: ${formatRate(cfg.replies, cfg.every)}` : ""}`);
      }
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
    const meta = { by: interaction.user.id, guildId: interaction.guildId, name: interaction.channel?.name ?? null };
    if (sub === "conversar") {
      const cfg = state.configure(channelId, { mode: "livre" }, meta);
      state.unmute(channelId);
      return interaction.reply(`oba, modo livre aqui! vou entrar no papo sozinha (${formatRate(cfg.replies, cfg.every)} de chance em cada mensagem, dá pra mudar no /configurar) 👀`);
    }
    if (sub === "padrao") {
      state.configure(channelId, { mode: "padrao" }, meta);
      return interaction.reply("tá bom, aqui eu respondo quando me marcarem, derem reply ou me chamarem");
    }
    if (sub === "desligar") {
      state.configure(channelId, { mode: "off" }, meta);
      return interaction.reply(`ok, desligada aqui. só respondo com \`/perguntar\` ou \`${runtime.defaults.commandPrefix}tetos\``);
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

  if (name === "configurar") {
    if (!interaction.guildId) return interaction.reply({ content: "isso é coisa de servidor — aqui no privado eu já converso normal", ...eph });
    if (!canManage(interaction, ctx)) return interaction.reply({ content: "só quem pode gerenciar o canal mexe nisso", ...eph });
    const meta = { by: interaction.user.id, guildId: interaction.guildId, name: interaction.channel?.name ?? null };
    if (opt.getBoolean("reset")) state.reset(interaction.channelId);
    const replies = opt.getInteger("respostas") ?? 1;
    const every = opt.getInteger("mensagem");
    const tagEvery = opt.getInteger("marcação");
    const patch = {
      mode: opt.getString("modo") ?? undefined,
      ...(every ? { replies, every } : {}),
      ...(tagEvery ? { tagReplies: replies, tagEvery } : {})
    };
    const changed = patch.mode || every || tagEvery;
    const cfg = changed ? state.configure(interaction.channelId, patch, meta) : state.channel(interaction.channelId);
    return interaction.reply(formatChannelConfig(cfg, { reset: Boolean(opt.getBoolean("reset")) }));
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

  if (name === "mente") {
    if (!runtime.mind) return interaction.reply({ content: "minha mente tá desligada por aqui", ...eph });
    await interaction.deferReply(eph);
    const text = await runtime.mind.command(interaction.options.getString("comando") ?? "", { isOwner: ctx.isOwnerId(interaction.user.id), userId: ctx.identityOf(interaction.user).userId });
    return interaction.editReply({ content: String(text).slice(0, 1990) });
  }

  if (name === "sentimentos") {
    if (!runtime.mind?.feelings) return interaction.reply({ content: "não tô conseguindo olhar pra dentro agora", ...eph });
    const text = runtime.mind.feelings.report(interaction.options.getString("sobre") ?? "", {
      viewerUserId: ctx.identityOf(interaction.user).userId,
      isOwner: ctx.isOwnerId(interaction.user.id)
    });
    return interaction.reply({ content: String(text).slice(0, 1990), ...eph });
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

  // Mídia, links e edição: vira o comando de ponto equivalente e roda pelo mesmo caminho do .comando.
  const mapped = slashToCommand(name, opt);
  const cmd = mapped ? findCommand(mapped.command) : null;
  if (!cmd) return;
  await interaction.deferReply();
  const attachment = opt.getAttachment?.("arquivo") ?? null;
  const send = interactionSender(interaction);
  const findMedia = async () =>
    attachment
      ? downloadMediaItem({ id: attachment.id, url: attachment.url, name: attachment.name, contentType: attachment.contentType, size: attachment.size }, media.inboxDir)
      : findChannelMedia({ channel: interaction.channel, inboxDir: media.inboxDir });
  try {
    await runDiscordCommand({ kind: "known", cmd, args: mapped.args, rest: mapped.args.join(" ") }, ctx, {
      author: interaction.user,
      channel: interaction.channel,
      isDM: !interaction.guildId,
      send,
      findMedia
    });
  } catch (error) {
    await send({ content: `deu ruim: ${error?.message ?? error}` }).catch(() => {});
  }
  if (!send.count()) await interaction.editReply({ content: "pronto" }).catch(() => {});
}

/**
 * Comandos de ponto (.sticker, .yt, .cortar, .dado…) numa mensagem do Discord, pelo catálogo do zap:
 * apelidos e erro de digitação valem, e "quis dizer…?" quando não dá pra ter certeza. true = tratou.
 */
export async function handlePrefixCommand(message, ctx) {
  const { runtime, media } = ctx;
  const prefix = runtime.defaults.commandPrefix || ".";
  const text = readableContent(message, { botId: message.client.user.id });
  const resolved = resolveCommand(text, prefix);
  if (!resolved || resolved.viaSlash) return false;
  const isDM = !message.guildId;
  const send = messageSender(message);
  if (resolved.kind === "suggest") {
    await send({ content: `hm, não conheço \`${prefix}${resolved.token}\` 🤔 quis dizer \`${prefix}${resolved.suggestion.name}\`? (\`${prefix}help\` mostra tudo)` });
    return true;
  }
  if (resolved.kind === "unknown") {
    if (!isDM) return false;
    await send({ content: `não conheço \`${prefix}${resolved.token}\` 🤔 manda \`${prefix}help\` pra ver tudo que eu sei fazer` });
    return true;
  }
  const quoted = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
  const out = await runDiscordCommand(resolved, ctx, {
    author: message.author,
    channel: message.channel,
    isDM,
    send,
    quotedText: quoted ? readableContent(quoted, { botId: message.client.user.id }) : "",
    findMedia: () => findChannelMedia({ message, inboxDir: media.inboxDir })
  }).catch(async (error) => {
    await send({ content: `deu ruim: ${error?.message ?? error}` }).catch(() => {});
    return { handled: true };
  });
  return Boolean(out?.handled);
}
