import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { seededRandom } from "../life/dayPlanner.js";

/**
 * Quando a Teto puxa assunto sozinha — e por quê. Como amiga de verdade: só com quem é próximo,
 * só quando ela está livre e acordada, nunca duas vezes seguidas sem resposta, e sempre com um motivo
 * (aniversário, "como foi aquilo?", bom dia, algo que aconteceu no dia dela, saudade).
 */

const HOUR = 3_600_000;
const EVAL_EVERY_MS = 5 * 60_000;

export class InitiativeState {
  constructor(path = "./data/life/initiative.json", { now = () => Date.now() } = {}) {
    this.path = path;
    this.now = now;
    this.data = readJson(path, { users: {}, lastEvalAt: 0 });
    this.data.users ??= {};
  }

  user(userId) {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const row = (this.data.users[userId] ??= { lastAt: 0, unanswered: 0, dayKey: today, dayCount: 0, done: [] });
    if (row.dayKey !== today) Object.assign(row, { dayKey: today, dayCount: 0 });
    return row;
  }

  /** A pessoa respondeu/escreveu: ela pode voltar a puxar assunto no futuro. */
  noteUserMessage(userId) {
    const row = this.data.users[userId];
    if (row?.unanswered) {
      row.unanswered = 0;
      this.save();
    }
  }

  noteSent(userId, reasonKey) {
    const row = this.user(userId);
    row.lastAt = this.now();
    row.unanswered += 1;
    row.dayCount += 1;
    if (reasonKey) row.done = [...row.done.slice(-30), reasonKey];
    this.save();
  }

  shouldEvaluate() {
    if (this.now() - (this.data.lastEvalAt ?? 0) < EVAL_EVERY_MS) return false;
    this.data.lastEvalAt = this.now();
    return true;
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }
}

/**
 * Decide se puxa assunto com essa pessoa agora. Pura (testável): recebe tudo pronto.
 * @returns {null | { reasonKey: string, mode: string, impulse: string }}
 */
export function chooseInitiative({
  now = Date.now(),
  availability,
  dayInfo = {},
  person = {},
  row = { lastAt: 0, unanswered: 0, dayCount: 0, done: [] },
  rng = seededRandom(`ini:${person.userId}:${Math.floor(now / EVAL_EVERY_MS)}`)
} = {}) {
  const { isOwner = false, isPartner = false, intimacy = 0, gapSinceUserMs = 0, gapSinceAnyMs = 0, followUps = [], name = null } = person;
  const close = isOwner || isPartner || intimacy >= 0.55;
  if (!close) return null;
  if (!availability || availability.mode !== "online" || availability.groggy) return null;
  if (dayInfo.minutesAwake != null && dayInfo.minutesAwake < 15) return null;
  if (dayInfo.minutesToBed != null && dayInfo.minutesToBed < 20) return null;

  // Nunca manda outra sem a pessoa responder a anterior (a dona, só depois de um dia inteiro).
  if (row.unanswered >= 1 && !(isOwner && row.unanswered < 2 && gapSinceUserMs > 24 * HOUR)) return null;
  if (row.dayCount >= (isOwner || isPartner ? 2 : 1)) return null;
  if (now - (row.lastAt ?? 0) < 3 * HOUR) return null;
  // Conversa rolando (ou acabou de rolar): não atropela.
  if (gapSinceAnyMs < (isOwner || isPartner ? 2 : 4) * HOUR) return null;

  const who = name ?? "essa pessoa";
  const today = new Date(now).toISOString().slice(0, 10);
  const done = new Set(row.done ?? []);
  const options = [];

  const birthday = followUps.find((f) => /^hoje é/.test(f));
  if (birthday && !done.has(`bday:${today}`)) options.push({ p: 0.6, reasonKey: `bday:${today}`, mode: "carinho", impulse: `${birthday} (${who}). Mande parabéns do seu jeito: carinhoso, sem texto pronto de cartão.` });

  for (const f of followUps.filter((x) => x.startsWith("perguntar como foi"))) {
    const key = `fu:${f}`;
    if (!done.has(key)) options.push({ p: 0.3, reasonKey: key, mode: "curiosidade", impulse: `Você lembrou que ${who} tinha uma coisa marcada — ${f.replace(/^perguntar como foi: /, "")}. Pergunte como foi, curiosa de verdade, sem cobrar.` });
  }

  if ((isOwner || isPartner) && dayInfo.minutesAwake != null && dayInfo.minutesAwake < 90 && !done.has(`bomdia:${today}`)) {
    options.push({ p: 0.12, reasonKey: `bomdia:${today}`, mode: "bom dia", impulse: `Você acabou de acordar (${availability.activity}) e lembrou de ${who}. Mande um bom dia curto e com a sua cara, sem pergunta de robô.` });
  }

  if (dayInfo.freshEvent) {
    const key = `ev:${today}:${dayInfo.freshEvent}`;
    if (!done.has(key)) options.push({ p: isOwner || isPartner ? 0.07 : 0.03, reasonKey: key, mode: "contar novidade", impulse: `Aconteceu agora no seu dia: ${dayInfo.freshEvent}. Você quis contar pra ${who} — conta do seu jeito, curtinho.` });
  }

  if (gapSinceUserMs > 36 * HOUR) {
    options.push({ p: 0.05, reasonKey: `saudade:${today}`, mode: "saudade", impulse: `Faz uns ${Math.round(gapSinceUserMs / (24 * HOUR))} dia(s) que você e ${who} não se falam. Puxe assunto leve (algo seu, uma pergunta específica) — sem "sumiu hein", sem cobrar.` });
  }

  if (isOwner || isPartner) {
    options.push({ p: 0.012, reasonKey: `share:${today}`, mode: "compartilhar", impulse: `Você está ${availability.activity} e lembrou de ${who}. Mande algo sobre isso (comentário, pergunta, besteira) — como amiga que manda mensagem do nada.` });
  }

  for (const opt of options) {
    if (!done.has(opt.reasonKey) && rng.chance(opt.p)) return { reasonKey: opt.reasonKey, mode: opt.mode, impulse: opt.impulse };
  }
  return null;
}
