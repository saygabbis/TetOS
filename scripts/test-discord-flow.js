// Fluxo do Discord ponta a ponta com um "servidor de mentira": quando responde, prompt sabe que é Discord,
// conversa livre, troca de app (zap espera) e vínculo de conta. O LLM é trocado por resposta fixa.
import "./isolatedData.js";
import { createRuntime } from "../src/app/createRuntime.js";
import { ChatMessageIndex } from "../src/integrations/whatsapp/inbound/chatMessageIndex.js";
import { DeferredInbox } from "../src/integrations/whatsapp/conversation/deferredInbox.js";
import { DiscordStateStore } from "../src/integrations/discord/discordState.js";
import { createDiscordConversation } from "../src/integrations/discord/discordConversation.js";
import { assert, ok } from "./test-helpers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Espera ela mandar a n-ésima mensagem (ela "pensa" uns segundos antes). */
const sentCount = async (n, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end && sent.length < n; ) await sleep(200);
  return sent.length;
};
const runtime = createRuntime();
runtime.defaults.replyEnabled = true;
runtime.brainOrchestrator.life.realism = "off";
runtime.chatMessageIndex = new ChatMessageIndex({ maxPerChannel: 80 });
const prompts = [];
runtime.agent.brain.generate = async (prompt) => {
  prompts.push(String(typeof prompt === "string" ? prompt : JSON.stringify(prompt)));
  const lines = ['mensagem("oii @fulano, tô aqui")', 'mensagem("vi sim, foi caótico kkk")', 'mensagem("fala gabbis")', 'mensagem("tava ensaiando mas vim")', 'mensagem("conta, o que foi?")', 'mensagem("ah sim entendi")'];
  return lines[(prompts.length - 1) % lines.length];
};

const OWNER = "333644956453568512";
runtime.defaults.ownerDiscordIds = [OWNER];
const sent = [];
const guild = { id: "g1", name: "Servidor", members: { cache: new Map(), me: null }, channels: { cache: new Map() }, roles: { cache: new Map() } };
const makeChannel = (id, dm = false) => ({
  id,
  name: dm ? undefined : "geral",
  guild: dm ? null : guild,
  lastMessageId: null,
  isTextBased: () => true,
  isDMBased: () => dm,
  sendTyping: async () => {},
  send: async (p) => {
    sent.push({ channel: id, ...p });
    return { id: String(9e17 + sent.length), channelId: id, author: { id: "bot" }, content: p.content ?? "", createdTimestamp: Date.now(), attachments: new Map(), stickers: new Map(), mentions: {} };
  },
  messages: { fetch: async (q) => (typeof q === "object" ? new Map() : null) }
});
const channels = { c1: makeChannel("c1"), dm1: makeChannel("dm1", true) };
const client = { user: { id: "bot" }, channels: { fetch: async (id) => channels[id] }, users: { cache: new Map() } };

let seq = 1;
const msg = (content, { channel = "c1", author = "u1", name = "Fulano", mentionsBot = false } = {}) => ({
  id: String(1e17 + seq++),
  content,
  channelId: channel,
  guildId: channels[channel].guild ? "g1" : null,
  author: { id: author, username: name, bot: false },
  member: { displayName: name },
  createdTimestamp: Date.now(),
  channel: channels[channel],
  guild: channels[channel].guild,
  attachments: new Map(),
  stickers: new Map(),
  mentions: { has: (id) => mentionsBot && id === "bot", users: new Map(), members: new Map(), roles: new Map() },
  reference: null,
  client
});

const state = new DiscordStateStore(null);
const inbox = new DeferredInbox(null);
const conv = createDiscordConversation({ runtime, client, state, media: { inboxDir: "./data/media/discord" }, inbox, log: { log() {}, warn() {}, error: console.error } });

try {
  await conv.handleMessage(msg("bora jogar hoje?"));
  await sleep(3000);
  assert(sent.length === 0, "sem marcar e sem conversa livre: fica quieta");

  await conv.handleMessage(msg("<@bot> oi teto", { mentionsBot: true }));
  assert((await sentCount(1)) === 1, `marcada: responde (${sent.length})`);
  assert(/oii/.test(sent[0].content), "manda o texto da IA");
  assert(sent[0].allowedMentions?.parse?.length === 0, "nunca @everyone");
  const prompt = prompts.at(-1);
  assert(/\[ONDE VOCÊ ESTÁ — DISCORD — #geral no servidor Servidor\]/.test(prompt), "prompt sabe que é o Discord");
  assert(!/ZERO markdown/.test(prompt), "no Discord o markdown leve é liberado");
  assert(runtime.attention.switchDelayMs("whatsapp") > 0, "conversando no Discord: o zap espera uns segundos");

  state.setFreeChat("c1", true);
  await conv.handleMessage(msg("e aí, alguém viu o jogo ontem?", { author: "u2", name: "Ciclano" }));
  assert((await sentCount(2)) === 2, "conversa livre com papo quente: entra sem ser marcada");

  await conv.handleMessage(msg("oi", { channel: "dm1", author: OWNER, name: "Gabbis" }));
  await sentCount(3);
  assert(sent.some((s) => s.channel === "dm1"), "DM: responde");
  assert(/\[DONA DO BOT — GABBIS\]/.test(prompts.at(-1)), "dona reconhecida no Discord");

  // Ocupada: guarda e responde depois, sabendo que só viu agora (e não "enquanto dormia").
  const life = runtime.brainOrchestrator.life;
  const realAvailability = life.availability.bind(life);
  life.availability = () => ({ mode: "busy", activity: "gravando um cover", delayMs: 800 });
  const before = sent.length;
  await conv.handleMessage(msg("teto, tá aí?", { channel: "dm1", author: "u3", name: "Beltrano" }));
  await conv.handleMessage(msg("responde quando der", { channel: "dm1", author: "u3", name: "Beltrano" }));
  await sleep(2000);
  assert(sent.length === before, "ocupada: não responde na hora");
  life.availability = realAvailability;
  conv.deliverDue();
  assert((await sentCount(before + 1)) === before + 1, "pegou o celular: responde o que ficou guardado");
  const caughtPrompt = prompts.at(-1);
  assert(/\[VOCÊ SÓ VIU AGORA\][\s\S]*gravando um cover/.test(caughtPrompt), "prompt diz o que ela estava fazendo");
  assert(!/Enquanto você dormia/.test(caughtPrompt), "ocupada não é dormindo");
  assert(/tá aí\?\nresponde quando der/.test(caughtPrompt), "as duas mensagens viram um turno só");

  // Ocupada, mas marcaram: vem na hora; a próxima msg da mesma pessoa (sem marcar) também, por 30 s.
  life.availability = () => ({ mode: "busy", activity: "ensaiando vocal", delayMs: 5 * 60_000 });
  state.setFreeChat("c1", false);
  let n = sent.length;
  await conv.handleMessage(msg("<@bot> vem cá", { author: "u4", name: "Fulana", mentionsBot: true }));
  assert((await sentCount(n + 1)) === n + 1, "marcada: vem na hora mesmo ocupada");
  n = sent.length;
  await conv.handleMessage(msg("então, sobre aquilo", { author: "u4", name: "Fulana" }));
  assert((await sentCount(n + 1)) === n + 1, "dentro de 30 s: responde sem precisar marcar");
  n = sent.length;
  await conv.handleMessage(msg("eu também quero falar", { author: "u5", name: "Outra" }));
  await sleep(3500);
  assert(sent.length === n, "a janela é só de quem chamou");
  runtime.summons.until.clear();
  await conv.handleMessage(msg("tá aí ainda?", { author: "u4", name: "Fulana" }));
  await sleep(3500);
  assert(sent.length === n, "janela fechou: sem marcar, não é chamada");
  life.availability = realAvailability;

  const { code } = runtime.identityLinks.createCode({ discordId: "u1", discordName: "fulano" });
  runtime.identityLinks.redeem(code, { userId: "dm-5511999", name: "Fulano" });
  assert(conv.identityOf({ id: "u1" }).userId === "dm-5511999", "vinculado: no Discord é a mesma pessoa do zap");
  ok("discord flow");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
