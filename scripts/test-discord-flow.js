// Fluxo do Discord ponta a ponta com um "servidor de mentira": quando responde, prompt sabe que é Discord,
// conversa livre, troca de app (zap espera) e vínculo de conta. O LLM é trocado por resposta fixa.
import "./isolatedData.js";
import { createRuntime } from "../src/app/createRuntime.js";
import { ChatMessageIndex } from "../src/integrations/whatsapp/inbound/chatMessageIndex.js";
import { DeferredInbox } from "../src/integrations/whatsapp/conversation/deferredInbox.js";
import { DiscordStateStore } from "../src/integrations/discord/discordState.js";
import { createDiscordConversation } from "../src/integrations/discord/discordConversation.js";
import sharp from "sharp";
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
const forced = [];
runtime.agent.brain.generate = async (prompt) => {
  prompts.push(String(typeof prompt === "string" ? prompt : JSON.stringify(prompt)));
  if (forced.length) return forced.shift();
  // Textos sempre diferentes: o filtro anti-repetição descartaria resposta igual.
  const topics = ["jogo", "pão", "música", "anime", "gato", "chuva", "sorvete", "karaokê", "live", "série", "cover", "baguete"];
  if (prompts.length === 1) return 'mensagem("oii @fulano, tô aqui")';
  return `mensagem("falando de ${topics[prompts.length % topics.length]} agora, rodada ${prompts.length}")`;
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
// Sorteios controlados: chance de entrar no papo / responder marcação.
let rnd = 0;
const conv = createDiscordConversation({ random: () => rnd, runtime, client, state, media: { inboxDir: "./data/media/discord", emojiDir: "./data/media/discord/emoji" }, inbox, log: { log() {}, warn() {}, error: console.error } });

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

  // Modo livre, 1 a cada 2 (50%): cada mensagem é um sorteio.
  state.configure("c1", { mode: "livre", replies: 1, every: 2 });
  rnd = 0.7;
  await conv.handleMessage(msg("e aí, alguém viu o jogo ontem?", { author: "u2", name: "Ciclano" }));
  await sleep(3500);
  assert(sent.length === 1, "livre: sorteio não saiu, fica quieta");
  rnd = 0.3;
  await conv.handleMessage(msg("foi muito bom", { author: "u6", name: "Beltrana" }));
  assert((await sentCount(2)) === 2, "livre: sorteio saiu, ela entra no papo");
  assert(/Conversa livre: ninguém te chamou/.test(prompts.at(-1)), "prompt sabe que ela está entrando sozinha");

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

  // Ocupada e marcaram: NÃO vem na hora (guarda). Só o comando (.tetos) chama; aí 30 s de papo aberto.
  life.availability = () => ({ mode: "busy", activity: "ensaiando vocal", delayMs: 5 * 60_000 });
  state.configure("c1", { mode: "padrao" });
  let n = sent.length;
  await conv.handleMessage(msg("<@bot> vem cá", { author: "u4", name: "Fulana", mentionsBot: true }));
  await sleep(3500);
  assert(sent.length === n, "marcada ocupada: espera (igual ao zap)");
  await conv.handleMessage(msg(".tetos vem cá agora", { author: "u4", name: "Fulana" }));
  assert((await sentCount(n + 1)) === n + 1, ".tetos: vem na hora mesmo ocupada");
  n = sent.length;
  await conv.handleMessage(msg("então, sobre aquilo", { author: "u4", name: "Fulana" }));
  assert((await sentCount(n + 1)) === n + 1, "dentro de 30 s do .tetos: responde sem chamar de novo");
  n = sent.length;
  await conv.handleMessage(msg("eu também quero falar", { author: "u5", name: "Outra" }));
  await sleep(3500);
  assert(sent.length === n, "a janela é só de quem chamou");
  life.availability = realAvailability;

  // Marcação com chance 1 a cada 3: sorteio não saiu → deixa passar; saiu → responde.
  state.configure("c1", { mode: "padrao", tagReplies: 1, tagEvery: 3 });
  runtime.summons.until.clear();
  n = sent.length;
  rnd = 0.9;
  await conv.handleMessage(msg("<@bot> e aí", { author: "u8", name: "Sorteado", mentionsBot: true }));
  await sleep(3500);
  assert(sent.length === n, "marcação: sorteio não saiu, deixa passar");
  rnd = 0.1;
  await conv.handleMessage(msg("<@bot> e aí de novo", { author: "u8", name: "Sorteado", mentionsBot: true }));
  assert((await sentCount(n + 1)) === n + 1, "marcação: sorteio saiu, responde");
  state.reset("c1");

  // Off: marcação não adianta; comando sim.
  state.configure("c1", { mode: "off" });
  runtime.summons.until.clear();
  n = sent.length;
  await conv.handleMessage(msg("<@bot> oi", { author: "u7", name: "Alguém", mentionsBot: true }));
  await sleep(3500);
  assert(sent.length === n, "off: ignora marcação");
  await conv.handleMessage(msg(".tetos oi", { author: "u7", name: "Alguém" }));
  assert((await sentCount(n + 1)) === n + 1, "off: .tetos funciona");

  // "Fica quieta por 1 hora": respeita e avisa uma vez; "pode voltar" libera.
  state.configure("c1", { mode: "padrao" });
  runtime.summons.until.clear();
  n = sent.length;
  const replies = [];
  const hushMsg = msg("<@bot> fica quieta por 1 hora", { author: OWNER, name: "Gabbis", mentionsBot: true });
  hushMsg.reply = async (p) => replies.push(p.content);
  await conv.handleMessage(hushMsg);
  assert(/fico quieta aqui até <t:\d+:t>/.test(replies[0] ?? ""), "avisa até quando fica quieta");
  assert(state.mutedUntil("c1") - Date.now() > 59 * 60_000, "1 hora de silêncio");
  await conv.handleMessage(msg("<@bot> e aí?", { author: "u2", name: "Ciclano", mentionsBot: true }));
  await sleep(3500);
  assert(sent.length === n, "quieta: não responde marcação");
  await conv.handleMessage(msg("<@bot> pode voltar a falar", { author: OWNER, name: "Gabbis", mentionsBot: true }));
  assert((await sentCount(n + 1)) === n + 1 && !state.mutedUntil("c1"), "a dona libera e ela volta");

  // Figurinha sai do tamanho de um emoji.
  forced.push('sticker("teto-linguinha")\nmensagem("olha eu")');
  n = sent.length;
  await conv.handleMessage(msg("oi de novo", { channel: "dm1", author: OWNER, name: "Gabbis" }));
  await sentCount(n + 2);
  const file = sent.slice(n).find((s) => s.files)?.files?.[0];
  assert(file && /\.(png|gif)$/.test(file.name), "figurinha vai como imagem pequena");
  const meta = await sharp(file.attachment, { animated: true }).metadata();
  assert(meta.width === 48, `figurinha com 48 px (veio ${meta.width})`);

  const { code } = runtime.identityLinks.createCode({ discordId: "u1", discordName: "fulano" });
  runtime.identityLinks.redeem(code, { userId: "dm-5511999", name: "Fulano" });
  assert(conv.identityOf({ id: "u1" }).userId === "dm-5511999", "vinculado: no Discord é a mesma pessoa do zap");
  ok("discord flow");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
