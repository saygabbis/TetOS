import { randomInt } from "node:crypto";
import { detectReminderIntent } from "../../../modules/reminders/reminderIntent.js";
import { formatHelp } from "./commandHelp.js";

/**
 * Comandos "de texto" (não precisam de mídia nem de link): utilidades, diversão e acessibilidade
 * de texto. Cada um devolve { text } ou { voice } pra quem chamou mandar — e sempre com uma linha
 * dizendo o que foi feito, pra pessoa saber que deu certo.
 *
 * Comandos de mídia/link (sticker, download, convert, transcrever, ler…) ficam no MediaCommandService.
 */

export const GENERAL_COMMANDS = new Set([
  "ping",
  "status",
  "sobre",
  "dado",
  "moeda",
  "escolher",
  "sortear",
  "calc",
  "hora",
  "clima",
  "lembrete",
  "falar",
  "traduzir",
  "resumir"
]);

const TZ_DEFAULT = "America/Sao_Paulo";

/**
 * @param {{ cmd: { name: string }, args: string[], rest: string }} resolved
 * @param {{ runtime: any, prefix?: string, isGroup?: boolean, isOwner?: boolean, userId?: string, chatId?: string, quotedText?: string, receivedAt?: number }} ctx
 * @returns {Promise<{ text?: string, voice?: { audio: Buffer, seconds: number }, caption?: string } | null>}
 */
export async function runGeneralCommand(resolved, ctx = {}) {
  const name = resolved?.cmd?.name;
  if (!GENERAL_COMMANDS.has(name)) return null;
  const rest = String(resolved.rest ?? "").trim();
  const args = resolved.args ?? [];
  const p = ctx.prefix || ".";
  switch (name) {
    case "ping": {
      const lag = ctx.receivedAt ? Math.max(0, Date.now() - ctx.receivedAt) : null;
      return { text: `pong 🏓${lag != null ? ` (${lag} ms)` : ""}\ntô on, pode mandar` };
    }
    case "status":
      return { text: statusText(ctx) };
    case "sobre":
      return { text: aboutText(p) };
    case "dado":
      return { text: rollDice(rest) };
    case "moeda":
      return { text: randomInt(2) ? "🪙 deu *cara*" : "🪙 deu *coroa*" };
    case "escolher":
      return { text: choose(rest, p) };
    case "sortear":
      return { text: draw(rest, p) };
    case "calc":
      return { text: calcText(rest, p) };
    case "hora":
      return { text: nowText(ctx.runtime?.defaults?.dailyReportTz ?? TZ_DEFAULT) };
    case "clima":
      return { text: await weatherText(rest, ctx) };
    case "lembrete":
      return { text: reminderText(rest, ctx) };
    case "falar":
      return speak(rest || ctx.quotedText || "", ctx);
    case "traduzir":
      return { text: await translate(args, rest, ctx) };
    case "resumir":
      return { text: await summarize(rest || ctx.quotedText || "", ctx) };
    default:
      return null;
  }
}

/** Texto do .help (com contexto de quem pede). */
export function helpText(args, ctx = {}) {
  return formatHelp(args, ctx.prefix || ".", { isOwner: ctx.isOwner, isGroup: ctx.isGroup });
}

function statusText(ctx) {
  const rt = ctx.runtime ?? {};
  const up = process.uptime();
  const h = Math.floor(up / 3600);
  const m = Math.floor((up % 3600) / 60);
  const lines = ["📊 *status da Teto*", `• online há ${h ? `${h}h ` : ""}${m}min`];
  if (ctx.isGroup) {
    const active = rt.tetoActivation?.isGroupActive?.(ctx.chatId);
    if (active != null) lines.push(`• neste grupo: ${active ? "ligada ✅" : "desligada (manda .teto-ativar aqui)"}`);
  } else {
    const active = rt.tetoActivation?.isDmActive?.(ctx.userId);
    if (active != null) lines.push(`• no seu PV: ${active ? "ligada ✅" : "desligada (manda .teto-ativar)"}`);
  }
  try {
    const now = rt.brainOrchestrator?.life?.availability?.({ chatId: ctx.chatId, isOwner: ctx.isOwner });
    if (now?.mode) {
      const label = now.mode === "asleep" ? "dormindo 😴" : now.mode === "online" ? "de boa no celular 📱" : "meio ocupada";
      lines.push(`• agora: ${label}${now.activity ? ` (${now.activity})` : ""}`);
    }
  } catch {
    /* rotina é opcional */
  }
  const watches = rt.priceWatch?.watchesOf?.({ platform: "whatsapp", chatId: ctx.chatId })?.length ?? 0;
  if (watches) lines.push(`• monitorando ${watches} preço(s) aqui`);
  const reminders = (rt.reminders?.list?.(ctx.userId) ?? []).filter((r) => !r.done && !r.deliveredAt).length;
  if (reminders) lines.push(`• ${reminders} lembrete(s) seu(s) pendente(s)`);
  return lines.join("\n");
}

function aboutText(p) {
  return [
    "🥖 *eu sou a Teto* (Kasane Teto)",
    "converso, faço figurinha, baixo vídeo/música, converto arquivo, transcrevo áudio, descrevo imagem, lembro de coisas e monitoro preço.",
    "",
    `• comandos: *${p}help*`,
    "• no grupo eu respondo quando me marcam (@) ou respondem minha mensagem",
    "• dá pra pedir conversando também: _\"teto, transforma isso em figurinha\"_"
  ].join("\n");
}

export function rollDice(spec = "") {
  const m = String(spec ?? "").trim().toLowerCase().match(/^(\d{1,2})?\s*d\s*(\d{1,4})(?:\s*([+-])\s*(\d{1,4}))?$/);
  const n = Math.min(20, Math.max(1, Number(m?.[1] ?? 1)));
  const sides = Math.min(1000, Math.max(2, Number(m?.[2] ?? (Number(spec) > 1 ? spec : 6))));
  const bonus = m?.[3] ? (m[3] === "-" ? -1 : 1) * Number(m[4]) : 0;
  const rolls = Array.from({ length: n }, () => randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + bonus;
  const label = `${n}d${sides}${bonus ? (bonus > 0 ? `+${bonus}` : bonus) : ""}`;
  return n === 1 && !bonus ? `🎲 ${label}: *${total}*` : `🎲 ${label}: [${rolls.join(", ")}]${bonus ? ` ${bonus > 0 ? "+" : ""}${bonus}` : ""} = *${total}*`;
}

function splitOptions(text = "") {
  const t = String(text ?? "").trim();
  const parts = /[,;|\n]/.test(t) ? t.split(/[,;|\n]+/) : t.split(/\s+ou\s+/i);
  return parts.map((x) => x.trim()).filter(Boolean);
}

function choose(text, p) {
  const opts = splitOptions(text);
  if (opts.length < 2) return `me dá pelo menos 2 opções separadas por vírgula\nex.: ${p}escolher pizza, sushi, hambúrguer`;
  return `🤔 entre ${opts.length} opções… vai de *${opts[randomInt(opts.length)]}*`;
}

function draw(text, p) {
  const t = String(text ?? "").trim();
  const nums = t.match(/^(-?\d+)(?:\s+(?:a|até|ate|-)?\s*(-?\d+))?$/i);
  if (!t || nums) {
    let lo = nums ? Number(nums[1]) : 1;
    let hi = nums?.[2] != null ? Number(nums[2]) : nums ? lo : 100;
    if (nums && nums[2] == null) [lo, hi] = [1, lo];
    if (lo > hi) [lo, hi] = [hi, lo];
    if (hi - lo > 1e9) return "intervalo grande demais 😅";
    return `🎰 de ${lo} a ${hi}: *${randomInt(lo, hi + 1)}*`;
  }
  const opts = splitOptions(t);
  if (opts.length < 2) return `ex.: ${p}sortear 1 100 · ${p}sortear ana, bia, caio`;
  return `🎰 sorteado: *${opts[randomInt(opts.length)]}*`;
}

/* ---------- calculadora (sem eval) ---------- */

export function evaluateExpression(input = "") {
  let src = String(input ?? "")
    .toLowerCase()
    .replace(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de|of)\s*/g, "($1/100)*")
    .replace(/[x×]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\*\*/g, "^")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\s+/g, "");
  if (!src || /[^0-9.+\-*/^%()]/.test(src)) throw new Error("só números e + - * / ^ % ( )");
  let i = 0;
  const peek = () => src[i];
  const eat = (c) => (src[i] === c ? (i += 1, true) : false);
  function number() {
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/.exec(src.slice(i));
    if (!m) throw new Error("conta incompleta");
    i += m[0].length;
    let v = Number(m[0]);
    if (eat("%")) v /= 100;
    return v;
  }
  function factor() {
    if (eat("-")) return -factor();
    if (eat("+")) return factor();
    let v;
    if (eat("(")) {
      v = expr();
      if (!eat(")")) throw new Error("faltou fechar parêntese");
    } else v = number();
    if (eat("^")) v = v ** factor();
    return v;
  }
  function term() {
    let v = factor();
    for (;;) {
      if (eat("*")) v *= factor();
      else if (eat("/")) {
        const d = factor();
        if (d === 0) throw new Error("divisão por zero");
        v /= d;
      } else if (peek() === "(") v *= factor();
      else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  }
  const out = expr();
  if (i < src.length) throw new Error("não entendi a conta");
  if (!Number.isFinite(out)) throw new Error("resultado infinito");
  return out;
}

function formatNumber(n) {
  return Number.isInteger(n) ? n.toLocaleString("pt-BR") : n.toLocaleString("pt-BR", { maximumFractionDigits: 6 });
}

function calcText(text, p) {
  if (!String(text ?? "").trim()) return `manda a conta\nex.: ${p}calc (12+8)*3 · ${p}calc 15% de 80`;
  try {
    return `🧮 ${text.trim()} = *${formatNumber(evaluateExpression(text))}*`;
  } catch (error) {
    return `não consegui fazer essa conta: ${error.message}`;
  }
}

function nowText(timeZone) {
  const d = new Date();
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(d);
  return `🕒 *${time}* · ${date} (horário de Brasília)`;
}

async function weatherText(city, ctx) {
  const weather = ctx.runtime?.weather;
  if (!weather?.forecast) return "previsão do tempo indisponível agora";
  try {
    const f = await weather.forecast(city || undefined);
    if (!f) return `não achei a cidade *${city}* 🤔`;
    const [today, next] = f.days;
    return [
      `🌤️ *${f.place}*`,
      `agora: *${f.now.temp}°C* (sensação ${f.now.feels}°C), ${f.now.sky}${f.now.rain > 0 ? ", chovendo" : ""}`,
      today ? `hoje: ${today.min}–${today.max}°C, ${today.sky}${today.rainChance != null ? `, ${today.rainChance}% de chuva` : ""}` : null,
      next ? `amanhã: ${next.min}–${next.max}°C, ${next.sky}${next.rainChance != null ? `, ${next.rainChance}% de chuva` : ""}` : null
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return "o serviço do tempo não respondeu, tenta daqui a pouco";
  }
}

function reminderText(text, ctx) {
  const p = ctx.prefix || ".";
  const store = ctx.runtime?.reminders;
  if (!store?.create) return "lembretes indisponíveis agora";
  const body = String(text ?? "").trim();
  if (!body) return `fala quando e o quê\nex.: ${p}lembrete 30min tirar o bolo · ${p}lembrete amanhã 9h reunião`;
  if (/^(lista|listar|ver|meus)$/i.test(body)) {
    const mine = store.list(ctx.userId).filter((r) => !r.done && !r.deliveredAt);
    if (!mine.length) return "você não tem lembrete pendente comigo";
    const tz = ctx.runtime?.defaults?.dailyReportTz ?? TZ_DEFAULT;
    return ["⏰ *seus lembretes*", ...mine.slice(0, 15).map((r) => `• ${r.text}${r.dueAt ? ` — ${fmtWhen(r.dueAt, tz)}` : ""}`)].join("\n");
  }
  const tz = ctx.runtime?.defaults?.dailyReportTz ?? TZ_DEFAULT;
  const phrase = /^\d/.test(body) ? `me lembra em ${body}` : `me lembra ${body}`;
  const intent = detectReminderIntent(phrase, { timeZone: tz });
  if (intent?.type !== "create" || !intent.dueAt) {
    return `não entendi *quando* 🤔\nex.: ${p}lembrete 30min tirar o bolo · ${p}lembrete 18:30 ligar pra mãe · ${p}lembrete amanhã 9h reunião`;
  }
  const r = store.create({ userId: ctx.userId, chatJid: ctx.chatId ?? null, text: intent.text, dueAt: intent.dueAt });
  return `⏰ fechado! te lembro de *${r.text}* ${fmtWhen(r.dueAt, tz)}`;
}

function fmtWhen(iso, timeZone) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "short", day: "2-digit", month: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(d);
  return `${day} às ${time}`;
}

async function speak(text, ctx) {
  const p = ctx.prefix || ".";
  const clean = String(text ?? "").trim().slice(0, 1200);
  if (!clean) return { text: `manda o texto ou responde uma mensagem\nex.: ${p}falar bom dia gente` };
  const voice = ctx.runtime?.voiceNotes;
  if (!voice?.synthesize) return { text: "minha voz tá indisponível agora" };
  try {
    const out = await voice.synthesize(clean);
    return { voice: out };
  } catch (error) {
    if (error?.code === "voice_no_credit") return { text: voice.creditNotice?.(ctx.chatId ?? "cmd", { isOwner: ctx.isOwner === true }) ?? "tô sem crédito de voz agora 😭" };
    return { text: `não consegui gravar o áudio (${error?.message ?? error})` };
  }
}

const LANGS = {
  pt: "português do Brasil", en: "inglês", es: "espanhol", fr: "francês", it: "italiano", de: "alemão", ja: "japonês",
  jp: "japonês", ko: "coreano", zh: "chinês", ru: "russo", ar: "árabe", hi: "hindi", nl: "holandês", tr: "turco"
};
const LANG_WORDS = {
  portugues: "pt", ingles: "en", english: "en", espanhol: "es", spanish: "es", frances: "fr", italiano: "it", alemao: "de",
  japones: "ja", coreano: "ko", chines: "zh", russo: "ru", arabe: "ar"
};

function langOf(token = "") {
  const t = String(token ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (LANGS[t]) return t;
  return LANG_WORDS[t] ?? null;
}

async function llmText(ctx, prompt) {
  const llm = ctx.runtime?.brain;
  if (!llm?.generate) throw new Error("IA indisponível");
  const out = await llm.generate(prompt);
  return String(out ?? "")
    .replace(/^mensagem\("([\s\S]*)"\)\s*$/, "$1")
    .trim();
}

async function translate(args, rest, ctx) {
  const p = ctx.prefix || ".";
  let lang = langOf(args[0]);
  let text = lang ? rest.split(/\s+/).slice(1).join(" ") : rest;
  if (!text.trim()) text = ctx.quotedText || "";
  if (!lang) lang = "pt";
  if (!text.trim()) return `manda o texto ou responde uma mensagem\nex.: ${p}traduzir en bom dia · ${p}traduzir (respondendo)`;
  try {
    const out = await llmText(
      ctx,
      `Traduza para ${LANGS[lang]}. Responda SÓ com a tradução, sem aspas e sem comentário.\n\nTexto:\n${text.slice(0, 3000)}`
    );
    return `🌐 *${LANGS[lang]}:*\n${out}`;
  } catch (error) {
    return `não consegui traduzir agora (${error?.message ?? error})`;
  }
}

async function summarize(text, ctx) {
  const p = ctx.prefix || ".";
  const t = String(text ?? "").trim();
  if (t.length < 200) return `responde uma mensagem comprida com ${p}resumir (ou cola o texto depois do comando)`;
  try {
    const out = await llmText(
      ctx,
      `Resuma em português do Brasil, em até 5 tópicos curtos com "•", só o essencial. Sem introdução.\n\nTexto:\n${t.slice(0, 8000)}`
    );
    return `📝 *resumo:*\n${out}`;
  } catch (error) {
    return `não consegui resumir agora (${error?.message ?? error})`;
  }
}
