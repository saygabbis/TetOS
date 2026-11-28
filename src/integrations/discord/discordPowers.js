/**
 * Poderes do Discord pra Teto: enquete, evento do servidor, timeout ("mutar"), expulsar, apelido,
 * fixar e falar em outro canal/PV. Segurança igual à do zap: moderação só se quem pediu é a dona ou
 * tem a permissão no servidor (e o bot também tem); nunca contra a dona nem contra o próprio bot;
 * falar em outro lugar: a dona manda em qualquer lugar, os outros só deixam recado pra dona.
 */
import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, PermissionFlagsBits } from "discord.js";
import { normalizeZapAction, parseWhen } from "../whatsapp/actions/zapPowers.js";

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^[@#]/, "")
    .trim();

async function findMember(guild, target) {
  const raw = String(target ?? "").trim();
  const id = raw.match(/\d{15,}/)?.[0];
  if (id) return guild.members.fetch(id).catch(() => null);
  const want = norm(raw);
  if (!want) return null;
  const found = await guild.members.fetch({ query: raw.replace(/^@/, ""), limit: 5 }).catch(() => null);
  const list = found ? [...found.values()] : [...guild.members.cache.values()];
  return list.find((m) => [m.displayName, m.user?.username, m.user?.globalName].some((n) => n && norm(n) === want)) ?? list[0] ?? null;
}

function minutesOf(raw = "", fallback = 10) {
  const t = String(raw).toLowerCase();
  const n = Number(t.match(/\d+/)?.[0] ?? fallback);
  if (/d|dia/.test(t)) return n * 1440;
  if (/h/.test(t)) return n * 60;
  return n;
}

/** Fala em outro canal (#nome) ou PV (@pessoa / "Gabbis") do Discord. */
export async function discordSendElsewhere({ runtime, client, last, target, text }) {
  const msg = String(text ?? "").trim();
  if (!msg) return { ok: false, note: "faltou o que falar" };
  const owners = runtime.defaults.ownerDiscordIds ?? [];
  const want = norm(target);
  const toOwner = /^(gabbis|gabi|gabbrielly|dona)$/.test(want);
  if (!last.isOwner && !toOwner) return { ok: false, note: "só a Gabbis pode me mandar falar com outras pessoas; recado pra ela eu levo" };
  if (toOwner) {
    const user = owners[0] ? await client.users.fetch(owners[0]).catch(() => null) : null;
    if (!user) return { ok: false, note: "não achei a Gabbis aqui no Discord" };
    await user.send(last.isOwner ? msg : `recado de ${last.speakerName ?? "alguém"}: ${msg}`);
    return { ok: true };
  }
  const guild = last.guildId ? await client.guilds.fetch(last.guildId).catch(() => null) : null;
  const channel = guild
    ? [...(await guild.channels.fetch().catch(() => new Map())).values()].find((c) => c?.isTextBased?.() && norm(c.name).includes(want))
    : null;
  if (channel) {
    await channel.send({ content: msg, allowedMentions: { parse: [] } });
    return { ok: true };
  }
  const member = guild ? await findMember(guild, target) : null;
  if (member) {
    await member.send(msg);
    return { ok: true };
  }
  return { ok: false, note: `não achei "${target}" por aqui` };
}

/**
 * zap("acao", ...) no Discord.
 * @returns {Promise<{ ok: boolean, note?: string }>}
 */
export async function runDiscordAction({ runtime, client, channel, last, action, args = [] }) {
  const name = normalizeZapAction(action);
  const [a1, a2, a3, a4] = args.map((x) => (x == null ? "" : String(x)));
  if (name === "enquete") {
    const options = a2.split(/\s*[|;\n]\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 10);
    if (!a1 || options.length < 2) return { ok: false, note: "enquete precisa de pergunta e 2+ opções" };
    await channel.send({
      poll: { question: { text: a1.slice(0, 300) }, answers: options.map((t) => ({ text: t.slice(0, 55) })), duration: 24, allowMultiselect: /^(sim|multi|1|true)$/i.test(a3.trim()) }
    });
    return { ok: true };
  }
  const guild = last.guildId ? await client.guilds.fetch(last.guildId).catch(() => null) : null;
  if (!guild) return { ok: false, note: "isso só dá em servidor" };
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const requester = await guild.members.fetch(last.authorId).catch(() => null);
  const can = (perm) => last.isOwner || Boolean(requester?.permissions?.has?.(perm));
  const owners = runtime.defaults.ownerDiscordIds ?? [];
  const protect = (m) => (!m ? "não achei essa pessoa" : owners.includes(m.id) ? "na Gabbis eu não mexo 😤" : m.id === me?.id ? "em mim mesma não" : null);

  if (name === "evento") {
    if (!can(PermissionFlagsBits.ManageEvents)) return { ok: false, note: "só quem pode criar evento no servidor me pede isso" };
    const start = parseWhen(a2) ?? new Date(Date.now() + 86400_000);
    await guild.scheduledEvents.create({
      name: a1.slice(0, 100) || "evento",
      description: a3.slice(0, 1000) || undefined,
      scheduledStartTime: start,
      scheduledEndTime: new Date(start.getTime() + 2 * 3600_000),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: a4 || "aqui no servidor" }
    });
    return { ok: true };
  }
  if (name === "fixar" || name === "desfixar") {
    if (!can(PermissionFlagsBits.ManageMessages)) return { ok: false, note: "só quem modera me pede isso" };
    const msg = await channel.messages.fetch(a1.trim() || last.messageId).catch(() => null);
    if (!msg) return { ok: false, note: "não achei a mensagem" };
    await (name === "fixar" ? msg.pin() : msg.unpin());
    return { ok: true };
  }
  if (name === "fechar" || name === "remover" || name === "nome" || name === "apelido" || name === "apagar") {
    const target = name === "apagar" ? null : await findMember(guild, a1);
    if (name === "fechar") {
      if (!can(PermissionFlagsBits.ModerateMembers)) return { ok: false, note: "só moderação pode me pedir pra mutar" };
      const err = protect(target);
      if (err) return { ok: false, note: err };
      await target.timeout(Math.min(40320, minutesOf(a2, 10)) * 60_000, `pedido de ${last.speakerName ?? "mod"} pra Teto`);
      return { ok: true };
    }
    if (name === "remover") {
      if (!can(PermissionFlagsBits.KickMembers)) return { ok: false, note: "só moderação pode me pedir pra expulsar" };
      const err = protect(target);
      if (err) return { ok: false, note: err };
      await target.kick(`pedido de ${last.speakerName ?? "mod"} pra Teto`);
      return { ok: true };
    }
    if (name === "nome" || name === "apelido") {
      if (!can(PermissionFlagsBits.ManageNicknames)) return { ok: false, note: "só quem pode mudar apelido me pede isso" };
      if (!target) return { ok: false, note: "não achei essa pessoa" };
      await target.setNickname(a2.slice(0, 32) || null);
      return { ok: true };
    }
    if (name === "apagar") {
      if (!can(PermissionFlagsBits.ManageMessages)) return { ok: false, note: "só quem modera me pede isso" };
      const msg = await channel.messages.fetch(a1.trim()).catch(() => null);
      if (!msg) return { ok: false, note: "não achei a mensagem" };
      await msg.delete();
      return { ok: true };
    }
  }
  return { ok: false, note: `isso ("${action}") eu não sei fazer no Discord` };
}
