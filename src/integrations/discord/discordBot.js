import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, Partials } from "discord.js";
import { DeferredInbox } from "../whatsapp/conversation/deferredInbox.js";
import { ChatMessageIndex } from "../whatsapp/inbound/chatMessageIndex.js";
import { deliverDueReminders } from "../../modules/reminders/reminderDelivery.js";
import { DiscordStateStore } from "./discordState.js";
import { createDiscordMediaTools } from "./discordMedia.js";
import { createDiscordConversation } from "./discordConversation.js";
import { buildCommandDefinitions, handleInteraction, handlePrefixCommand } from "./discordCommands.js";

/**
 * Bot da Teto no Discord. Roda dentro do mesmo processo do WhatsApp (mesma memória em disco, mesma
 * vida, mesma atenção) — dois processos gravando os mesmos JSONs corromperiam os dados.
 *
 * Falha aqui nunca derruba o zap: tudo é capturado e logado.
 */

const AVAILABILITY_STATUS = { online: "online", partial: "online", absorbed: "idle", busy: "dnd", away: "idle", asleep: "idle" };

export async function startDiscordBot(runtime, { log = console } = {}) {
  const defaults = runtime.defaults;
  if (!defaults.discordEnabled) {
    log.log?.("[discord] desligado (sem DISCORD_BOT_TOKEN ou DISCORD_ENABLED=false)");
    return null;
  }
  runtime.chatMessageIndex ??= new ChatMessageIndex({ maxPerChannel: 80 });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message],
    allowedMentions: { parse: [], repliedUser: false }
  });

  const state = new DiscordStateStore(defaults.discordStatePath);
  const inbox = new DeferredInbox(defaults.discordInboxPath);
  const media = createDiscordMediaTools(runtime);
  const conversation = createDiscordConversation({ runtime, client, state, media, inbox, log });
  const ctx = { runtime, client, state, media, inbox, identityOf: conversation.identityOf, isOwnerId: conversation.isOwnerId, summonKeyOf: conversation.summonKeyOf, namesFor: conversation.namesFor, dlog: conversation.dlog };
  const timers = [];

  const api = {
    client,
    ready: false,
    /** Vínculo fechado lá no zap: avisa a pessoa no privado do Discord. */
    async notifyLinked(link) {
      const user = await client.users.fetch(link.discordId).catch(() => null);
      await user?.send?.(`pronto, vinculei! agora sei que você aqui é ${link.name ? `a mesma pessoa do zap (${link.name})` : "você do zap"} 💕`).catch(() => {});
    },
    say: (channelId, text) => conversation.say(channelId, text)
  };
  runtime.discord = api;
  // A mente avisa no Discord quem pediu algo pra ela (canal onde pediram: "discord:<id>").
  runtime.mind?.registerSender?.("discord", async ({ chatId, text }) => {
    if (!api.ready) throw new Error("discord offline");
    await conversation.say(String(chatId ?? "").replace(/^discord:/, ""), text);
  });

  client.once(Events.ClientReady, async (c) => {
    api.ready = true;
    log.log?.(`[discord] conectada como ${c.user.tag} em ${c.guilds.cache.size} servidor(es)`);
    try {
      const body = buildCommandDefinitions();
      if (defaults.discordGuildIds.length) {
        for (const guildId of defaults.discordGuildIds) await c.application.commands.set(body, guildId);
        log.log?.(`[discord] ${body.length} comandos registrados em ${defaults.discordGuildIds.length} servidor(es)`);
      } else {
        await c.application.commands.set(body);
        log.log?.(`[discord] ${body.length} comandos registrados (globais)`);
      }
    } catch (error) {
      log.error?.(`[discord] registrar comandos falhou: ${error?.message ?? error}`);
    }
    updatePresence();
    conversation.deliverDue();
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author?.bot) return;
      if (await handlePrefixCommand(message, ctx)) return;
      await conversation.handleMessage(message);
    } catch (error) {
      log.error?.(`[discord] mensagem falhou: ${error?.stack ?? error}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction, ctx);
    } catch (error) {
      log.error?.(`[discord] comando ${interaction.commandName ?? "?"} falhou: ${error?.stack ?? error}`);
      const content = `deu ruim aqui: ${String(error?.message ?? error).slice(0, 300)}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content, files: [], embeds: [] }).catch(() => {});
      else await interaction.reply?.({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on(Events.Error, (error) => log.error?.(`[discord] erro do cliente: ${error?.message ?? error}`));
  client.on(Events.ShardDisconnect, () => log.warn?.("[discord] desconectou — o discord.js reconecta sozinho"));

  /** Bolinha do Discord acompanha a vida dela: livre = online, entretida/na rua/dormindo = ausente, focada = não perturbe. */
  let lastPresence = "";
  function updatePresence() {
    if (!client.user) return;
    try {
      const life = runtime.brainOrchestrator?.life;
      const avail = life?.availability?.({ isOwner: false });
      const status = AVAILABILITY_STATUS[avail?.mode] ?? "online";
      const activity = avail?.mode === "asleep" ? "dormindo 💤" : avail?.activity ?? null;
      // Só manda pro Discord quando muda (checa todo minuto).
      if (`${status}|${activity}` === lastPresence) return;
      lastPresence = `${status}|${activity}`;
      client.user.setPresence({ status, activities: activity ? [{ name: activity, type: ActivityType.Custom, state: activity }] : [] });
    } catch (error) {
      log.warn?.(`[discord] presença falhou: ${error?.message ?? error}`);
    }
  }

  timers.push(setInterval(() => conversation.deliverDue(), 20_000));
  // A cada minuto: pausa de 5 min na rotina não pode ficar aparecendo depois que acabou.
  timers.push(setInterval(updatePresence, 60_000));
  timers.push(
    setInterval(() => {
      if (!api.ready) return;
      deliverDueReminders(runtime, null, { replyEnabled: defaults.replyEnabled, platform: "discord", send: (channelId, text) => conversation.say(channelId, text) }).catch((error) =>
        log.error?.(`[discord] lembretes: ${error?.message ?? error}`)
      );
    }, defaults.reminderSweepMs ?? 60_000)
  );
  for (const t of timers) t.unref?.();

  // Login recusado (ex.: intent desligado no portal, token trocado): tenta de novo sozinha a cada minuto,
  // sem precisar reiniciar o zap depois de arrumar.
  const login = async (attempt = 1) => {
    try {
      await client.login(defaults.discordToken);
    } catch (error) {
      if (attempt === 1 || attempt % 30 === 0) log.error?.(`[discord] login falhou (tentativa ${attempt}): ${error?.message ?? error} — tento de novo a cada minuto`);
      setTimeout(() => void login(attempt + 1), 60_000).unref?.();
    }
  };
  await login();
  return api;
}
