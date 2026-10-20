/**
 * Detecta pedidos de lembrete em português natural e calcula o horário.
 *
 * Entende: "me lembra daqui 10 min de X", "me avisa em meia hora", "daqui a 2h", "às 15h", "15:30",
 * "amanhã às 9", "amanhã de manhã", "hoje à noite", números por extenso ("dez minutos").
 * Não confunde "você me lembra de alguém" (= faz lembrar) com pedido de lembrete.
 */

const DEFAULT_TZ = "America/Sao_Paulo";

const NUMBER_WORDS = {
  um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8,
  nove: 9, dez: 10, onze: 11, doze: 12, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50
};
const NUM = `(\\d+(?:[.,]\\d+)?|${Object.keys(NUMBER_WORDS).join("|")})`;
const UNIT = "(s|seg|segs|segundos?|m|min|mins|minutos?|h|hr|hrs|horas?|d|dias?)";

const TRIGGER = /\b(?:me\s+lembr(?:a|e|ar)|me\s+avis(?:a|e|ar)|cri(?:a|e|ar)\s+(?:um\s+)?lembrete|anot(?:a|e)\s+(?:um\s+)?lembrete|lembrete\s*[:\-]|lembrete\s+(?:pra|para|de)\b)/i;
/** "me avisa" sem horário ("me avisa quando chegar") não é lembrete. */
const NOTIFY_ONLY = /\bme\s+avis(?:a|e|ar)\b/i;
/** "você me lembra X" / "isso me lembra" = associação, não pedido. */
const ASSOCIATION = /\b(?:voc[eê]|vc|isso|isto|ele|ela|tu|esse|essa|aquilo|teu|seu|sua)\s+(?:me\s+)?lembra\b/i;

function toNumber(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s in NUMBER_WORDS) return NUMBER_WORDS[s];
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function unitMs(unit) {
  const u = String(unit ?? "").toLowerCase();
  if (u.startsWith("s")) return 1000;
  if (u === "m" || u.startsWith("min")) return 60 * 1000;
  if (u.startsWith("h")) return 60 * 60 * 1000;
  if (u.startsWith("d")) return 24 * 60 * 60 * 1000;
  return NaN;
}

/** Partes da data no fuso informado. */
function zonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}

/** Converte "Y-M-D h:m no fuso" para instante UTC. */
function zonedTimeToUtc({ y, mo, d, h, mi }, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = zonedParts(new Date(guess), timeZone);
  const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - guess;
  return new Date(guess - offset);
}

/** Tempo relativo: "daqui 10 min", "em meia hora", "daqui a 1h30", "10 minutos". Retorna { ms, match }. */
function parseRelative(text) {
  const half = text.match(/\b(?:daqui\s+(?:a\s+)?|em\s+|dentro\s+de\s+)?mei[ao]\s+hora\b/i);
  if (half) return { ms: 30 * 60 * 1000, match: half[0] };

  const hm = text.match(/\b(?:daqui\s+(?:a\s+)?|em\s+|dentro\s+de\s+)(\d{1,2})\s*h\s*(\d{1,2})\s*(?:min)?\b/i);
  if (hm) return { ms: (+hm[1] * 60 + +hm[2]) * 60 * 1000, match: hm[0] };

  const re = new RegExp(`\\b(?:daqui\\s+(?:a\\s+)?|em\\s+|dentro\\s+de\\s+)?${NUM}\\s*${UNIT}\\b`, "i");
  const m = text.match(re);
  if (!m) return null;
  const hasLead = /^(?:daqui|em|dentro)/i.test(m[0]);
  const unit = m[2].toLowerCase();
  // Sem "daqui/em", só aceita unidade explícita (evita "2 m" de metros, "3 d" etc.)
  if (!hasLead && unit.length <= 1) return null;
  const amount = toNumber(m[1]);
  const mult = unitMs(unit);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(mult)) return null;
  return { ms: Math.round(amount * mult), match: m[0] };
}

/** Fronteiras de palavra que entendem acento (o \\b do JS não trata "ã"/"à" como letra). */
const B = "(?<![\\p{L}\\d])";
const E = "(?![\\p{L}\\d])";
const rx = (src) => new RegExp(src.replaceAll("\\b<", B).replaceAll("\\b>", E), "iu");

const RX_TOMORROW = rx("\\b<amanh[aã]\\b>");
const RX_PERIOD = rx("\\b<(de manh[aã]|cedo|[àa] tarde|de tarde|[àa] noite|de noite)\\b>");
const RX_CLOCK = rx("(?:\\b<[àa]s?\\s+)?\\b<(\\d{1,2})(?::(\\d{2})|\\s*h(?:oras?)?\\s*(\\d{2})?)\\b>(?!\\s*(?:min|seg))");
const RX_AT = rx("\\b<[àa]s\\s+(\\d{1,2})\\b>");

/** Horário absoluto: "às 15h", "15:30", "amanhã às 9", "amanhã de manhã", "hoje à noite". */
function parseAbsolute(text, now, timeZone) {
  const tomorrowM = text.match(RX_TOMORROW);
  const period = text.match(RX_PERIOD);
  const clock = text.match(RX_CLOCK);
  const atWord = text.match(RX_AT);

  let hour = null, minute = 0;
  const fragments = [tomorrowM?.[0], period?.[0]];
  if (clock && (clock[2] != null || /h/i.test(clock[0]))) {
    hour = +clock[1]; minute = +(clock[2] ?? clock[3] ?? 0); fragments.push(clock[0]);
  } else if (atWord) {
    hour = +atWord[1]; fragments.push(atWord[0]);
  }
  if (hour == null && period) hour = /manh|cedo/i.test(period[1]) ? 9 : /tarde/i.test(period[1]) ? 15 : 20;
  if (hour == null && tomorrowM) hour = 9;
  if (hour == null) return null;
  if (period && /tarde|noite/i.test(period[1]) && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;

  const local = zonedParts(now, timeZone);
  let due = zonedTimeToUtc({ y: local.y, mo: local.mo, d: local.d, h: hour, mi: minute }, timeZone);
  if (tomorrowM) due = new Date(due.getTime() + 24 * 60 * 60 * 1000);
  else if (due.getTime() <= now.getTime()) {
    // "às 9" quando já passou das 9: se cabe à noite (21h) hoje, usa; senão amanhã.
    const pm = hour < 12 && !period ? new Date(due.getTime() + 12 * 60 * 60 * 1000) : null;
    due = pm && pm.getTime() > now.getTime() ? pm : new Date(due.getTime() + 24 * 60 * 60 * 1000);
  }
  return { dueAt: due, match: fragments.filter(Boolean) };
}

function cleanReminderText(raw, fragments = []) {
  let s = String(raw ?? "");
  s = s.replace(TRIGGER, " ");
  for (const f of fragments.flat().filter(Boolean)) s = s.replace(f, " ");
  s = s
    .replace(/(?<![\p{L}\d])(?:hoje|daqui|por favor|pf|pfv|teto)(?![\p{L}\d])/giu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,:\-–—\s]+/, "")
    .replace(/^(?:de|pra|para|que|do|da)\s+/i, "")
    .replace(/[,\s]+$/, "")
    .trim();
  return s;
}

export function detectReminderIntent(text, { now = new Date(), timeZone = DEFAULT_TZ } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (/\b(lista|listar|quais|meus|ver)\b.*\b(lembretes|reminders)\b/i.test(lower)) {
    return { type: "list" };
  }
  const doneMatch = raw.match(/\b(?:concluir|finalizar|marcar|apagar|cancelar)\s+(?:o\s+)?lembrete\s+([\w-]{6,})/i);
  if (doneMatch?.[1]) return { type: "done", id: doneMatch[1].trim() };

  if (!TRIGGER.test(raw) || ASSOCIATION.test(raw)) return null;

  const rel = parseRelative(raw);
  const abs = rel ? null : parseAbsolute(raw, now, timeZone);
  const dueAt = rel ? new Date(now.getTime() + rel.ms) : abs?.dueAt ?? null;
  const reminderText = cleanReminderText(raw, [rel?.match, abs?.match]);

  if (!dueAt) {
    if (NOTIFY_ONLY.test(raw) && !/\blembr/i.test(raw)) return null;
    // Pedido sem horário: não cria lembrete mudo (nunca seria entregue) — pipeline pede o horário.
    return { type: "needs_time", text: reminderText };
  }
  return { type: "create", text: reminderText || "o que você pediu", dueAt: dueAt.toISOString() };
}
