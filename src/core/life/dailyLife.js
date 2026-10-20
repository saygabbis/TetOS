import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { fmtClock, planDay, seededRandom, sleepWindow } from "./dayPlanner.js";

/**
 * A vida da Teto em tempo real (fuso dela): o que está fazendo agora, se dá pra responder,
 * se está dormindo, como está o humor — tudo derivado do plano do dia, igual pra todos os chats.
 *
 * Expõe também a interface antiga do ciclo de sono (`sleep.getSnapshot()`, `attemptDisturbanceWake`…)
 * e do motor de vida (`getSnapshot()`, `tick()`, `profile.get()`), para o resto do cérebro seguir igual.
 */

const DAY_MIN = 24 * 60;
const MIN = 60_000;
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const AVAIL_LABEL = {
  online: "livre, com o celular na mão",
  busy: "ocupada/focada — olha o celular de vez em quando",
  away: "na rua — responde quando dá",
  asleep: "dormindo"
};

/** Partes da data no fuso: { ymd, weekday, minutes }. */
export function localParts(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { ymd: `${p.year}-${p.month}-${p.day}`, weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function offsetMinutes(date, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date).find((x) => x.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

/** Date absoluta para "minutos desde a meia-noite local" de um dia (pode passar de 24h). */
export function zonedDate(ymd, minutes, timeZone) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d) + minutes * MIN);
  return new Date(guess.getTime() - offsetMinutes(guess, timeZone) * MIN);
}

const shiftYmd = (ymd, days) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const clamp01 = (n) => Math.max(0, Math.min(1, n));

export class DailyLife {
  /**
   * realism: "full" (padrão — dorme, fica ocupada, responde quando dá), "light" (demoras bem menores,
   * dorme igual) ou "off" (sempre disponível; útil em teste). Env: TETOS_LIFE_REALISM.
   */
  constructor({
    statePath = "./data/life/state.json",
    timeZone = "America/Sao_Paulo",
    // TETOS_LIFE_CLOCK_OFFSET_MS: desloca só o relógio da vida (testar "ela às 3h da manhã" sem esperar).
    now = () => new Date(Date.now() + (Number(process.env.TETOS_LIFE_CLOCK_OFFSET_MS) || 0)),
    bus = null,
    realism = process.env.TETOS_LIFE_REALISM || "full"
  } = {}) {
    this.realism = ["full", "light", "off"].includes(realism) ? realism : "full";
    this.statePath = statePath;
    this.timeZone = timeZone;
    this.now = now;
    this.bus = bus;
    this.state = readJson(statePath, { tempAwake: null, disturbances: {}, lastWokeAt: null });
    this.plans = new Map();
    this._wasAvailable = null;
    const self = this;
    this.profile = { get: () => ({ timezone: self.timeZone }) };
    this.sleep = this.buildSleepFacade();
  }

  save() {
    writeJsonDeferred(this.statePath, this.state);
  }

  plan(ymd) {
    if (!this.plans.has(ymd)) {
      const prev = shiftYmd(ymd, -1);
      this.plans.set(ymd, planDay(ymd, { weekday: weekdayOf(ymd), prevBed: sleepWindow(prev, weekdayOf(prev)).bed }));
      if (this.plans.size > 6) this.plans.delete(this.plans.keys().next().value);
    }
    return this.plans.get(ymd);
  }

  /** Onde ela está agora na linha do tempo: o dia "dela" (até ir dormir) e o bloco. */
  locate(date = this.now()) {
    const { ymd, minutes } = localParts(date, this.timeZone);
    const today = this.plan(ymd);
    const yesterday = this.plan(shiftYmd(ymd, -1));
    let day;
    let m;
    if (minutes + DAY_MIN < yesterday.bed) {
      day = yesterday;
      m = minutes + DAY_MIN;
    } else if (minutes >= today.wake && minutes < today.bed) {
      day = today;
      m = minutes;
    } else {
      // Dormindo: entre a hora que deitou e a que acorda.
      const sleepingDay = minutes < today.wake ? yesterday : today;
      const wakeDay = minutes < today.wake ? today : this.plan(shiftYmd(ymd, 1));
      return {
        day: sleepingDay,
        minute: minutes < today.wake ? minutes + DAY_MIN : minutes,
        block: { kind: "sleep", label: "dormindo", availability: "asleep", place: "quarto", start: sleepingDay.bed, end: DAY_MIN + wakeDay.wake },
        wakeAt: zonedDate(wakeDay.date, wakeDay.wake, this.timeZone),
        bedAt: zonedDate(sleepingDay.date, sleepingDay.bed, this.timeZone)
      };
    }
    const block = day.blocks.find((b) => m >= b.start && m < b.end) ?? {
      kind: "free",
      label: "de bobeira",
      availability: "online",
      place: "casa",
      start: m,
      end: Math.min(day.bed, (day.blocks.find((b) => b.start > m)?.start ?? day.bed))
    };
    return { day, minute: m, block, bedAt: zonedDate(day.date, day.bed, this.timeZone) };
  }

  tempAwakeFor(chatId = null, date = this.now()) {
    const ta = this.state.tempAwake;
    if (!ta || Date.parse(ta.until) <= date.getTime()) return false;
    return !chatId || !ta.chat || ta.chat === chatId;
  }

  isAsleep(date = this.now()) {
    return this.locate(date).block.kind === "sleep";
  }

  /** O que está fazendo / se dá pra responder esse chat agora, e daqui quanto tempo responderia. */
  availability({ chatId = null, isOwner = false, urgency = 0, date = this.now() } = {}) {
    const result = this.rawAvailability({ chatId, isOwner, urgency, date });
    if (this.realism === "off") return { ...result, mode: "online", delayMs: 0 };
    if (this.realism === "light" && result.mode !== "asleep") return { ...result, delayMs: Math.round(result.delayMs * 0.3) };
    return result;
  }

  rawAvailability({ chatId = null, isOwner = false, urgency = 0, date = this.now() } = {}) {
    const loc = this.locate(date);
    const { block } = loc;
    const untilMs = zonedDate(loc.day.date, block.end, this.timeZone).getTime() - date.getTime();
    const base = { mode: block.availability, activity: block.label, kind: block.kind, untilMs: Math.max(0, untilMs) };
    if (block.kind === "sleep") {
      if (this.tempAwakeFor(chatId, date)) return { ...base, mode: "online", groggy: true, delayMs: 0, tempAwake: true };
      // Acorda e só depois de um tempinho pega o celular.
      const rng = seededRandom(`acorda:${loc.wakeAt?.toISOString()}:${chatId ?? ""}`);
      const wakeLag = (isOwner ? rng.int(3, 12) : rng.int(8, 35)) * MIN;
      return { ...base, mode: "asleep", delayMs: Math.max(0, loc.wakeAt.getTime() - date.getTime()) + wakeLag };
    }
    if (block.availability === "online") return { ...base, delayMs: 0 };
    // Ocupada/na rua: olha o celular de vez em quando — a dona é vista antes; urgência encurta.
    const rng = seededRandom(`olha:${loc.day.date}:${block.start}:${chatId ?? ""}`);
    const [lo, hi] = block.availability === "busy" ? (isOwner ? [1, 5] : [3, 14]) : isOwner ? [2, 10] : [5, 28];
    let delay = rng.int(lo, hi) * MIN;
    delay = Math.min(delay, Math.max(MIN, untilMs + rng.int(1, 4) * MIN));
    if (urgency >= 0.7 || (isOwner && urgency >= 0.5)) delay = Math.min(delay, rng.int(30, 90) * 1000);
    return { ...base, delayMs: delay };
  }

  /** Tentativa de acordá-la (muita mensagem, "acorda", urgência). Até 2 vezes por noite. */
  tryWake({ chatId, score = 0, floodCount = 0, isOwner = false, date = this.now() } = {}) {
    if (!this.isAsleep(date)) return null;
    const night = this.locate(date).day.date;
    const count = this.state.disturbances[night] ?? 0;
    if (count >= 2) return null;
    const threshold = isOwner ? 0.55 : 0.8;
    const floodNeeded = isOwner ? 4 : 7;
    if (score < threshold && floodCount < floodNeeded) return null;
    this.state.disturbances = { ...Object.fromEntries(Object.entries(this.state.disturbances).slice(-6)), [night]: count + 1 };
    this.state.tempAwake = { chat: chatId, until: new Date(date.getTime() + 10 * MIN).toISOString(), startedAt: date.toISOString(), extensions: 0 };
    this.save();
    return { woke: true, groggy: true, chat: chatId, night };
  }

  extendWake(chatId, date = this.now()) {
    const ta = this.state.tempAwake;
    if (!ta || !this.tempAwakeFor(chatId, date)) return;
    const cap = Date.parse(ta.startedAt) + 30 * MIN;
    ta.until = new Date(Math.min(cap, Math.max(Date.parse(ta.until), date.getTime() + 4 * MIN))).toISOString();
    ta.extensions = (ta.extensions ?? 0) + 1;
    this.save();
  }

  /** Para a iniciativa: há quanto tempo acordou, quanto falta pra dormir, algo que acabou de acontecer. */
  dayInfo(date = this.now()) {
    const loc = this.locate(date);
    if (loc.block.kind === "sleep") return { asleep: true };
    const fresh = loc.day.events.filter((e) => e.at <= loc.minute && loc.minute - e.at <= 90).pop();
    return { minutesAwake: loc.minute - loc.day.wake, minutesToBed: loc.day.bed - loc.minute, freshEvent: fresh?.text ?? null };
  }

  /** Humor e energia do momento: acontecimentos do dia + sono + hora. */
  mood(date = this.now()) {
    const loc = this.locate(date);
    if (loc.block.kind === "sleep") return { mood: "dormindo", energy: 0.1, valence: 0.5, social: 0.2 };
    const awakeMin = loc.minute - loc.day.wake;
    const toBed = loc.day.bed - loc.minute;
    let energy = awakeMin < 30 ? 0.35 : awakeMin < 120 ? 0.6 : 0.8;
    if (toBed < 90) energy = Math.min(energy, 0.4);
    if ((this.state.disturbances[shiftYmd(loc.day.date, -1)] ?? 0) > 0) energy -= 0.15;
    const events = loc.day.events.filter((e) => e.at <= loc.minute);
    const valence = clamp01(0.58 + events.reduce((sum, e) => sum + e.mood * Math.exp(-(loc.minute - e.at) / 240), 0));
    energy = clamp01(energy);
    let label = valence >= 0.75 ? "animada" : valence >= 0.55 ? "de boa" : valence >= 0.42 ? "meio pra baixo" : "chateada";
    if (energy < 0.4) label = valence >= 0.55 ? "com soninho" : "cansada";
    return { mood: label, energy, valence, social: loc.block.availability === "online" ? 0.7 : 0.4 };
  }

  /** Blocos do prompt: o que está fazendo, o que fez, o que aconteceu, o que vem — pra falar com coerência. */
  promptLines({ isGroup = false, date = this.now() } = {}) {
    const loc = this.locate(date);
    const { day, block, minute } = loc;
    const parts = localParts(date, this.timeZone);
    const header = `[SUA VIDA AGORA — ${WEEKDAYS[parts.weekday]}, ${fmtClock(parts.minutes)}]`;
    const m = this.mood(date);
    if (block.kind === "sleep") {
      return [header, "Agora: você estava dormindo. Se está respondendo, é porque acordou com o celular — sono, frases curtas, meio grogue."];
    }
    const lines = [header];
    lines.push(`Agora: ${block.label} (desde ${fmtClock(block.start)}${block.end - minute > 5 ? `, até ~${fmtClock(block.end)}` : ""}) — ${AVAIL_LABEL[block.availability]}.`);
    lines.push(`Humor: ${m.mood}${m.energy < 0.4 ? " (energia baixa)" : m.energy > 0.7 ? " (com energia)" : ""}.`);
    if (!isGroup) {
      const earlier = day.blocks.filter((b) => b.end <= minute && !["waking", "meal", "selfcare", "free"].includes(b.kind)).slice(-3).map((b) => b.label);
      lines.push(`Hoje: acordou ${fmtClock(day.wake)}${earlier.length ? `; já esteve ${earlier.join("; ")}` : ""}.`);
      const happened = day.events.filter((e) => e.at <= minute).slice(-2).map((e) => e.text);
      if (happened.length) lines.push(`Aconteceu hoje: ${happened.join("; ")}.`);
      const next = day.blocks.filter((b) => b.start >= block.end && b.kind !== "selfcare").slice(0, 2).map((b) => `${b.label.replace(/^(tomando|almoçando|jantando)/, "$1")} ~${fmtClock(b.start)}`);
      lines.push(`Depois: ${next.length ? `${next.join("; ")}; ` : ""}dormir lá pra ${fmtClock(day.bed)}.`);
      const yesterday = this.plan(shiftYmd(day.date, -1));
      const yHighlights = yesterday.blocks.filter((b) => ["social", "work"].includes(b.kind)).slice(-2).map((b) => b.label);
      if (yHighlights.length) lines.push(`Ontem: ${yHighlights.join("; ")}; dormiu ${fmtClock(yesterday.bed)}.`);
    }
    lines.push(
      "Essa é a sua vida de verdade, a mesma pra todo mundo. Cite só quando encaixar (perguntaram o que tá fazendo, ou combina com o papo) — sem contar a rotina toda, sem inventar outra coisa, e sem falar de quem conversa com você no privado.",
      block.availability === "busy" ? "Ocupada: respostas mais curtas; pode dizer que tá no meio de algo." : block.availability === "away" ? "Na rua: respostas curtas, de celular." : ""
    );
    return lines.filter(Boolean);
  }

  // —— Interface antiga do motor de vida ——

  getSnapshot(date = this.now()) {
    const loc = this.locate(date);
    const phase = loc.minute < 12 * 60 ? "manha" : loc.minute < 18 * 60 ? "tarde" : loc.minute < DAY_MIN ? "noite" : "madrugada";
    return {
      currentActivity: loc.block.label,
      activityKind: loc.block.kind,
      availability: loc.block.availability,
      place: loc.block.place,
      friends: loc.block.friends ?? [],
      activityStartedAt: zonedDate(loc.day.date, loc.block.start, this.timeZone).toISOString(),
      phase,
      obligations: [],
      sleep: this.sleep.getSnapshot()
    };
  }

  /** Avisa quando ela "fica disponível" (acordou, voltou) — usado para responder o que guardou. */
  tick(when) {
    const date = when instanceof Date ? when : this.now();
    const available = !this.isAsleep(date) || this.tempAwakeFor(null, date);
    if (this._wasAvailable === false && available) this.bus?.emit?.("sleep.available", this.sleep.getSnapshot());
    this._wasAvailable = available;
  }

  buildSleepFacade() {
    const life = this;
    return {
      getSnapshot() {
        const date = life.now();
        const loc = life.locate(date);
        const asleep = loc.block.kind === "sleep";
        const tempAwake = asleep && life.tempAwakeFor(null, date);
        const night = loc.day.date;
        const disturbed = life.state.disturbances[asleep ? night : shiftYmd(night, -1)] ?? 0;
        const awakeMin = asleep ? 0 : loc.minute - loc.day.wake;
        return {
          state: asleep ? (tempAwake ? "groggy" : "asleep") : awakeMin < 40 ? "groggy" : "awake",
          isAvailable: !asleep || tempAwake,
          isTemporarilyAwake: tempAwake,
          tempWakeGrogginess: tempAwake ? 0.7 : 0,
          tempWakeExtensionCount: life.state.tempAwake?.extensions ?? 0,
          disturbanceCount: disturbed,
          sleepDebt: disturbed ? 0.3 : 0.1,
          quality: disturbed ? 0.6 : 0.85,
          lastWakeAt: asleep ? null : zonedDate(loc.day.date, loc.day.wake, life.timeZone).toISOString(),
          tonightPlan: { bedHour: Math.floor((loc.day.bed % DAY_MIN) / 60), wakeHour: Math.floor(life.plan(shiftYmd(loc.day.date, 1)).wake / 60) }
        };
      },
      isAvailable: () => !life.isAsleep() || life.tempAwakeFor(null),
      isTemporarilyAwake: () => life.isAsleep() && life.tempAwakeFor(null),
      checkTemporaryWake: () => {
        life.tick();
        return null;
      },
      attemptDisturbanceWake: ({ score = 0, floodCount = 0, chatId = null, isOwner = false } = {}) => life.tryWake({ chatId, score, floodCount, isOwner }),
      extendTemporaryWakeOnInteraction: (chatId = null) => life.extendWake(chatId ?? life.state.tempAwake?.chat),
      reconcileWithSchedule: () => {
        life.tick();
        return null;
      },
      tick: () => life.tick()
    };
  }
}
