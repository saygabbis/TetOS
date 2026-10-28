import { detectHushRequest } from "../../core/channels/hushRequest.js";

/**
 * Regras do Discord que não dependem do cliente: modo do canal, ritmo da conversa livre, pedido de
 * silêncio com prazo e acabamento das respostas (menos @, menos figurinha, menos bolha).
 *
 * Modos (por canal):
 *   off    — só responde a comando (/perguntar, .tetos).
 *   padrao — igual grupo ativado no zap: responde quando marcam, dão reply ou chamam pelo nome, e segue
 *            o papo com quem falou com ela por uns minutos.
 *   livre  — além disso, entra no papo sozinha com a chance configurada.
 *
 * Chances (por canal, em `/configurar`): "X respostas a cada Y" = X/Y de chance em CADA mensagem,
 * sorteada uma a uma (1 a cada 10 = 10%: pode sair na 2ª, na 9ª, duas seguidas — em média 1 a cada 10).
 *   mensagens  — conversa livre (quem não chamou ela). Padrão 1 a cada 4.
 *   marcações  — marcação, reply nela ou chamar pelo nome, no servidor. Padrão 1 a cada 1 (sempre).
 * Comando (/perguntar, .tetos) e DM não sorteiam.
 */

export const CHANNEL_MODES = ["off", "padrao", "livre"];
export const MODE_LABEL = { off: "desligada (só comando)", padrao: "padrão (marcação/reply/nome)", livre: "livre (entra no papo sozinha)" };
export const DEFAULT_RATE = { replies: 1, every: 4, tagReplies: 1, tagEvery: 1 };

/** Chance (0–1) de "X a cada Y". */
export function rateChance(replies = 1, every = 1) {
  const r = Math.max(0, Number(replies) || 0);
  const n = Math.max(1, Number(every) || 1);
  return Math.min(1, r / n);
}

/** Sorteio de uma mensagem: `kind` "mensagem" (conversa livre) ou "marcacao". */
export function rollRate(cfg = {}, kind = "mensagem", random = Math.random) {
  const c = { ...DEFAULT_RATE, ...cfg };
  const chance = kind === "marcacao" ? rateChance(c.tagReplies, c.tagEvery) : rateChance(c.replies, c.every);
  return chance >= 1 || random() < chance;
}

/** "1 a cada 10 (10%)". */
export function formatRate(replies, every) {
  const pct = Math.round(rateChance(replies, every) * 100);
  return `${replies} a cada ${every} (${pct}%)`;
}

const UNIT_MS = { s: 1000, seg: 1000, segundo: 1000, m: 60_000, min: 60_000, minuto: 60_000, h: 3_600_000, hr: 3_600_000, hora: 3_600_000, d: 86_400_000, dia: 86_400_000 };
const NUMBER_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, "três": 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, doze: 12, quinze: 15, vinte: 20, trinta: 30 };

/** "por 12 horas", "pelas próximas 2h", "10 min", "meia hora", "até amanhã" → ms (ou null). */
export function parseDuration(text = "") {
  const t = String(text ?? "").toLowerCase();
  if (/meia\s+hora/.test(t)) return 30 * 60_000;
  if (/at[eé]\s+amanh[aã]/.test(t)) return 12 * 3_600_000;
  if (/(?<![\p{L}])(?:o\s+)?resto\s+do\s+dia(?![\p{L}])/u.test(t)) return 8 * 3_600_000;
  const m = t.match(/(\d+(?:[.,]\d+)?|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta)\s*(segundos?|seg|s|minutos?|min|m|horas?|hrs?|h|dias?|d)(?![\p{L}])/u);
  if (!m) return /(?<![\p{L}])(?:um\s+)?pouco|um\s+tempo|um\s+minuto(?![\p{L}])/u.test(t) ? 10 * 60_000 : null;
  const n = NUMBER_WORDS[m[1]] ?? Number(m[1].replace(",", "."));
  const unit = m[2].replace(/s$/, "").replace(/^hrs?$/, "hr");
  const ms = n * (UNIT_MS[unit] ?? UNIT_MS[unit.replace(/o$/, "")] ?? 60_000);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 7 * 86_400_000) : null;
}

const AWAY = /(?<![\p{L}])(?:se\s+ausent[ae]|some|suma|sai(?:a)?\s+(?:daqui|do\s+(?:discord|servidor|chat|canal))|desaparece|vai\s+embora|para\s+de\s+aparecer|fica\s+off|fica\s+fora)(?![\p{L}])/iu;
const SCOPE_ALL = /(?<![\p{L}])(?:do\s+discord|no\s+discord|de\s+todos?\s+os\s+(?:canais|chats)|do\s+servidor(?:\s+todo)?|em\s+tudo)(?![\p{L}])/iu;

/**
 * Pedido pra ela ficar quieta/sumir, com prazo e escopo. null = não é pedido.
 * Sem prazo: 10 min. Escopo "discord" = todos os canais; "channel" = só onde pediram.
 */
export function parseHushRequest(text = "") {
  const t = String(text ?? "").trim();
  if (!t || t.length > 200) return null;
  if (!detectHushRequest(t) && !AWAY.test(t)) return null;
  return { ms: parseDuration(t) ?? 10 * 60_000, scope: SCOPE_ALL.test(t) ? "discord" : "channel" };
}

export function formatDuration(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round((ms / 3_600_000) * 10) / 10;
  return h < 24 ? `${String(h).replace(".", ",")}h` : `${Math.round(h / 24)} dia(s)`;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Acabamento da resposta no Discord:
 * - várias bolhas viram UMA mensagem (linhas), no máximo `maxLines`;
 * - quem ela está respondendo (reply) não é marcado: "@Lucas mds" → "mds", "mds @Lucas," → "mds Lucas,";
 * - no máximo uma marcação de verdade por resposta (as outras viram só o nome);
 * - figurinha só se não mandou uma há pouco (`stickerAllowed`).
 */
export function polishDiscordActions(actions = [], { replyToNames = [], maxLines = 2, stickerAllowed = true } = {}) {
  const out = [];
  const lines = [];
  let slot = -1;
  let quoteId = null;
  for (const a of actions) {
    if (a.type === "message" && a.text) {
      if (slot < 0) {
        slot = out.length;
        quoteId = a.quoteId ?? null;
      }
      lines.push(String(a.text).trim());
    } else if (a.type === "sticker" && !stickerAllowed) continue;
    else out.push(a);
  }
  if (!lines.length) return out;
  // Cada bolha antes de juntar: "@Lucas" no começo/fim some; no meio vira só o nome.
  const unmark = (line) => {
    let t = line;
    for (const name of replyToNames.filter(Boolean)) {
      const n = escapeRe(name);
      t = t
        .replace(new RegExp(`^@${n}(?![\\p{L}\\p{N}])[\\s,:!]*`, "iu"), "")
        .replace(new RegExp(`\\s+@${n}[\\s.!?]*$`, "iu"), "")
        .replace(new RegExp(`([\\s,(])@${n}(?![\\p{L}\\p{N}])`, "giu"), (_, lead) => `${lead}${name}`);
    }
    return t.trim();
  };
  const clean = lines.map(unmark).filter(Boolean);
  let text = clean.slice(0, maxLines).join("\n");
  if (clean.length > maxLines) text += ` ${clean.slice(maxLines).join(" ")}`;
  let seen = 0;
  text = text.replace(/(^|[\s(])@([\p{L}\p{N}_.\-]{2,32})/gu, (all, lead, raw) => (++seen > 1 ? `${lead}${raw}` : all));
  text = text.replace(/^\s*[,.]\s*/, "").trim();
  if (text) out.splice(slot, 0, { type: "message", text, quoteId });
  return out;
}
