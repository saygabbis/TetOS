/**
 * Planejador do dia da Teto: a partir da data (e só dela), monta o dia inteiro — que horas acordou,
 * o que faz em cada horário, com quem sai, o que acontece. Mesma data → mesmo dia, em qualquer
 * processo (WhatsApp, app, testes): a vida dela é uma só e não muda conforme quem pergunta.
 *
 * Nada aqui envolve usuários: amigos são personagens do universo dela (Miku, Rin, Len…).
 */

const DAY_MIN = 24 * 60;

/** PRNG pequeno e estável (mulberry32) com semente vinda de texto. */
export function seededRandom(seedText = "") {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i += 1) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p
  };
}

/** Amigos do universo dela (artigo certo: "a Miku", "o Ted"). */
const FRIENDS = [
  { name: "Miku", a: "a" }, { name: "Rin", a: "a" }, { name: "Len", a: "o" }, { name: "Luka", a: "a" },
  { name: "Neru", a: "a" }, { name: "Momo", a: "a" }, { name: "Defoko", a: "a" }, { name: "Ted", a: "o" }
];

/**
 * Atividades por tipo. availability: online (no celular), partial (fazendo algo, mas com o celular
 * do lado — conversa normal, só um pouco mais devagar), absorbed (entretida — anime, jogo, desenho:
 * olha o celular de vez em quando), busy (focada), away (na rua).
 * `hours` = janela em que faz sentido (minutos do dia). `maxDur` = teto de duração do bloco.
 * {friend} = "a Miku", {dafriend} = "da Miku".
 */
const POOLS = {
  work: [
    { label: "gravando um cover", availability: "busy", place: "estúdio" },
    { label: "ensaiando vocal", availability: "busy", place: "estúdio" },
    { label: "mixando uma faixa", availability: "busy", place: "estúdio" },
    { label: "compondo uma música nova", availability: "partial", place: "quarto" },
    { label: "editando um vídeo pro canal", availability: "partial", place: "quarto" },
    { label: "gravando as vozes de uma collab com {friend}", availability: "busy", place: "estúdio", withFriend: 1 },
    { label: "em call com o produtor", availability: "busy", place: "quarto", hours: [10 * 60, 19 * 60] }
  ],
  leisure: [
    { label: "jogando no PC", availability: "absorbed", place: "quarto" },
    { label: "vendo anime", availability: "absorbed", place: "sala" },
    { label: "maratonando uma série", availability: "absorbed", place: "sala" },
    { label: "lendo mangá", availability: "absorbed", place: "quarto" },
    { label: "vendo vídeo no YouTube", availability: "absorbed", place: "quarto" },
    { label: "desenhando", availability: "absorbed", place: "quarto" },
    { label: "ouvindo música nova", availability: "partial", place: "quarto" },
    { label: "de bobeira no quarto", availability: "online", place: "quarto", maxDur: 40 }
  ],
  social: [
    { label: "saindo com {friend}", availability: "away", place: "rua", withFriend: 1, hours: [14 * 60, 22 * 60] },
    { label: "no karaokê com {friend} e {friend2}", availability: "away", place: "karaokê", withFriend: 2, hours: [17 * 60, 23 * 60] },
    { label: "tomando sorvete com {friend}", availability: "away", place: "sorveteria", withFriend: 1, hours: [13 * 60, 20 * 60] },
    { label: "na casa {dafriend}", availability: "partial", place: "casa de amigo", withFriend: 1, hours: [14 * 60, 22 * 60] },
    { label: "jogando online com {friend}", availability: "absorbed", place: "quarto", withFriend: 1, hours: [16 * 60, 25 * 60] }
  ],
  errand: [
    { label: "na padaria comprando baguete", availability: "away", place: "padaria", hours: [8 * 60, 19 * 60] },
    { label: "no mercado", availability: "away", place: "mercado", hours: [9 * 60, 20 * 60] },
    { label: "resolvendo umas coisas na rua", availability: "away", place: "rua", hours: [9 * 60, 18 * 60] },
    { label: "na academia", availability: "away", place: "academia", hours: [8 * 60, 21 * 60] }
  ],
  chores: [
    { label: "arrumando o quarto", availability: "partial", place: "quarto", hours: [9 * 60, 21 * 60] },
    { label: "lavando a louça", availability: "partial", place: "cozinha", hours: [9 * 60, 22 * 60] },
    { label: "lavando roupa", availability: "partial", place: "área", hours: [9 * 60, 20 * 60] }
  ]
};
const KIND_HOURS = { work: [9 * 60, 21 * 60 + 30], social: [13 * 60, 23 * 60], errand: [8 * 60, 20 * 60], chores: [9 * 60, 22 * 60], leisure: [0, 30 * 60] };
const KIND_DURATION = { work: [60, 140], leisure: [45, 120], social: [90, 180], errand: [25, 60], chores: [20, 45] };

/**
 * A partir desse dia: mais tempo livre e blocos de trabalho mais curtos. Dias anteriores ficam
 * exatamente como ela viveu (o que ela já contou não muda).
 */
const LIGHTER_DAYS_FROM = "2026-10-23";
const LIGHTER_WORK_DURATION = [50, 110];

/**
 * A partir desse dia: tempo livre no celular vira blocos curtos (no resto do lazer ela está
 * entretida com outra coisa). Dias anteriores ficam como ela viveu.
 */
const PHONE_TIME_FROM = "2026-10-28";
const PHONE_TIME_LEISURE = [{ label: "de bobeira no celular", availability: "online", place: "quarto", maxDur: 30 }];

/** Pausas dentro de blocos longos de foco/rua: ninguém fica 2h sem olhar o celular. */
const BREAK_LABELS = {
  work: ["dando uma pausa, tomando água", "no intervalo, mexendo no celular", "esticando as pernas e olhando o celular"],
  social: ["foi no banheiro e aproveitou pra ver o celular", "numa pausa do rolê, mexendo no celular", "esperando o pedido, mexendo no celular"],
  errand: ["na fila, mexendo no celular", "parada um pouco, olhando o celular"],
  absorbed: ["deu uma pausa e pegou o celular", "foi pegar água e aproveitou pra ver o celular", "parou um pouquinho pra olhar o celular"]
};

/**
 * Pausas: foco/rua a cada 22–40 min (5–10 de pausa); entretida (anime, jogo) a cada 15–30 min (4–9).
 * Cada tipo tem sua semente, pra um não mudar as pausas do outro.
 */
function addBreaks(blocks, rng, absorbedRng = rng) {
  const out = [];
  for (const b of blocks) {
    const absorbed = b.availability === "absorbed";
    const pausable =
      (absorbed || b.availability === "busy" || b.availability === "away") && b.kind !== "selfcare" && b.end - b.start >= (absorbed ? 30 : 40);
    if (!pausable) {
      out.push(b);
      continue;
    }
    const r = absorbed ? absorbedRng : rng;
    const [segLo, segHi, pauseLo, pauseHi] = absorbed ? [15, 30, 4, 9] : [22, 40, 5, 10];
    let s = b.start;
    for (;;) {
      const segEnd = s + r.int(segLo, segHi);
      if (b.end - segEnd < (absorbed ? 10 : 15)) break;
      const pauseEnd = segEnd + r.int(pauseLo, pauseHi);
      out.push({ ...b, start: s, end: segEnd });
      out.push({
        kind: "break",
        label: r.pick(absorbed ? BREAK_LABELS.absorbed : BREAK_LABELS[b.kind] ?? BREAK_LABELS.work),
        availability: "online",
        place: b.place,
        friends: b.friends,
        during: b.label,
        start: segEnd,
        end: pauseEnd
      });
      s = pauseEnd;
    }
    out.push({ ...b, start: s, end: b.end });
  }
  return out;
}

const ANCHORS = {
  // 0 = domingo
  0: [{ at: 12 * 60 + 30, dur: 150, kind: "social", label: "no almoço de domingo na casa do Ted", availability: "away", place: "casa do Ted", friends: ["Ted"], replacesLunch: true }],
  2: [{ at: 15 * 60, dur: 90, kind: "work", label: "na aula de canto", availability: "busy", place: "escola de música" }],
  3: [{ at: 16 * 60, dur: 60, kind: "work", label: "em call de collab com a Miku", availability: "busy", place: "quarto", friends: ["Miku"] }],
  5: [{ at: 20 * 60 + 30, dur: 180, kind: "social", label: "no rolê de sexta com {friend} e {friend2}", availability: "away", place: "rua", withFriend: 2, replacesDinner: true }],
  6: [{ at: 21 * 60, dur: 120, kind: "work", label: "fazendo live no canal", availability: "busy", place: "quarto" }]
};

/** Acontecimentos; `kinds` = em que tipo de bloco podem acontecer (sem = qualquer um acordada). */
const EVENTS = [
  { text: "{Friend} me mandou um meme que me fez chorar de rir", mood: 0.2 },
  { text: "{Friend} me ligou do nada pra fofocar", mood: 0.15 },
  { text: "{Friend} pediu minha opinião numa música nova", mood: 0.15 },
  { text: "vi um gatinho na janela e fiquei um tempão olhando", mood: 0.1 },
  { text: "o fone que eu mais gosto começou a chiar", mood: -0.2 },
  { text: "dormi no sofá sem querer por uns minutos", mood: 0, kinds: ["leisure"] },
  { text: "queimei a torrada", mood: -0.1, kinds: ["meal"] },
  { text: "derrubei café na mesa", mood: -0.1, kinds: ["meal"] },
  { text: "choveu bem na hora que eu tava na rua", mood: -0.1, kinds: ["errand", "social"] },
  { text: "achei uma baguete perfeita na padaria", mood: 0.2, kinds: ["errand"] },
  { text: "finalmente destravei o refrão que tava me irritando", mood: 0.3, kinds: ["work"] },
  { text: "a gravação corrompeu e perdi uns takes", mood: -0.3, kinds: ["work"] },
  { text: "um cover meu passou de 10 mil views", mood: 0.35, kinds: ["work", "leisure"] },
  { text: "o produtor pediu pra refazer a ponte da música", mood: -0.15, kinds: ["work"] },
  { text: "acertei uma nota alta que eu nunca acertava", mood: 0.25, kinds: ["work"] },
  { text: "{Friend} me contou uma história hilária", mood: 0.2, kinds: ["social"] },
  { text: "tirei umas fotos bobas com {friend}", mood: 0.2, kinds: ["social"] },
  { text: "{Friend} chegou atrasada como sempre", mood: -0.05, kinds: ["social"], female: true },
  { text: "ganhei uma partida que tava impossível", mood: 0.2, kinds: ["leisure"] }
];

const friendByName = (name) => FRIENDS.find((f) => f.name === name) ?? { name, a: "a" };
const art = (f) => `${f.a} ${f.name}`;
const de = (f) => `${f.a === "o" ? "do" : "da"} ${f.name}`;
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function fillFriends(label, friends = []) {
  const [f1 = FRIENDS[0], f2 = f1] = friends.map(friendByName);
  return label
    .replace("{friend2}", art(f2))
    .replace("{Friend}", cap(art(f1)))
    .replace("{dafriend}", de(f1))
    .replace("{friend}", art(f1));
}

function pickFriends(rng, n, { femaleOnly = false } = {}) {
  const pool = FRIENDS.filter((f) => !femaleOnly || f.a === "a").map((f) => f.name);
  const out = [];
  for (let i = 0; i < n && pool.length; i += 1) out.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
  return out;
}

function materialize(rng, template, kind) {
  const friends = template.friends ?? pickFriends(rng, template.withFriend ?? 0);
  const entry = { kind, label: fillFriends(template.label, friends), availability: template.availability, place: template.place, friends };
  if (template.maxDur) entry.maxDur = template.maxDur;
  return entry;
}

const fits = (hours, t) => !hours || (t >= hours[0] && t < hours[1]);

/** Hora que acorda/dorme nesse dia (minutos desde a meia-noite local; dormir pode passar de 1440). */
export function sleepWindow(ymd, weekday) {
  const rng = seededRandom(`sono:${ymd}`);
  const wakeBase = weekday === 6 ? 10 * 60 : weekday === 0 ? 10 * 60 + 30 : 8 * 60 + 15;
  const bedBase = weekday === 5 || weekday === 6 ? DAY_MIN + 90 : weekday === 0 ? 23 * 60 + 15 : 23 * 60 + 50;
  return { wake: wakeBase + rng.int(-35, 45), bed: bedBase + rng.int(-35, 50) };
}

/**
 * Dia completo. `weekday` 0–6 (domingo = 0) do dia local; `prevBed` = minutos (em relação ao dia anterior)
 * em que ela foi dormir ontem — se foi tarde, acorda mais tarde.
 */
export function planDay(ymd, { weekday, prevBed = null } = {}) {
  const rng = seededRandom(`dia:${ymd}`);
  const win = sleepWindow(ymd, weekday);
  let wake = win.wake;
  if (prevBed != null && prevBed > DAY_MIN + 60) wake += Math.min(90, prevBed - (DAY_MIN + 60));
  const bed = Math.max(win.bed, wake + 13 * 60);

  const blocks = [];
  const push = (start, dur, entry) => {
    const s = Math.max(start, blocks.length ? blocks[blocks.length - 1].end : wake);
    const e = Math.min(bed, s + dur);
    if (e - s >= 10) blocks.push({ start: s, end: e, ...entry });
    return e;
  };

  let t = push(wake, rng.int(15, 30), { kind: "waking", label: "acordando, ainda na cama mexendo no celular", availability: "online", place: "quarto" });
  t = push(t, rng.int(20, 35), { kind: "meal", label: rng.pick(["tomando café com pão", "tomando café com baguete", "comendo pão na chapa"]), availability: "partial", place: "cozinha" });


  const anchors = (ANCHORS[weekday] ?? []).map((a) => ({ ...a, ...materialize(rng, a, a.kind), start: a.at, end: a.at + a.dur }));
  const meals = [
    { at: 12 * 60 + rng.int(15, 75), dur: rng.int(35, 50), label: rng.pick(["almoçando", "almoçando um miojo caprichado", "almoçando marmita"]), used: anchors.some((a) => a.replacesLunch) },
    { at: 19 * 60 + rng.int(30, 90), dur: rng.int(35, 50), label: rng.pick(["jantando", "jantando pão com sopa", "comendo uma pizza"]), used: anchors.some((a) => a.replacesDinner) }
  ];
  let showerDone = false;
  const usedTemplates = new Set();
  const lighter = ymd >= LIGHTER_DAYS_FROM;
  const pools = ymd >= PHONE_TIME_FROM ? { ...POOLS, leisure: [...POOLS.leisure, ...PHONE_TIME_LEISURE] } : POOLS;
  const durations = lighter ? { ...KIND_DURATION, work: LIGHTER_WORK_DURATION } : KIND_DURATION;
  const weights = weekday === 0 || weekday === 6
    ? { leisure: 4, social: 2, errand: 1, chores: 1, work: 1 }
    : lighter
      ? { work: 3, leisure: 4, errand: 1, chores: 1, social: 1 }
      : { work: 4, leisure: 3, errand: 1, chores: 1, social: 1 };

  let guard = 0;
  while (t < bed - 20 && guard++ < 40) {
    const anchor = anchors.find((a) => !a.used && a.start < t + 45);
    if (anchor) {
      anchor.used = true;
      t = push(Math.max(t, anchor.start), anchor.end - Math.max(t, anchor.start), { kind: anchor.kind, label: anchor.label, availability: anchor.availability, place: anchor.place, friends: anchor.friends });
      continue;
    }
    const meal = meals.find((m) => !m.used && t >= m.at - 20);
    if (meal) {
      meal.used = true;
      t = push(t, meal.dur, { kind: "meal", label: meal.label, availability: "partial", place: "cozinha" });
      continue;
    }
    if (!showerDone && t >= 21 * 60) {
      showerDone = true;
      t = push(t, rng.int(15, 25), { kind: "selfcare", label: "tomando banho", availability: "busy", place: "banheiro" });
      continue;
    }
    // Próximo marco fixo (âncora ou refeição) limita o tamanho do bloco.
    const nextFixed = Math.min(
      ...anchors.filter((a) => !a.used && a.start > t).map((a) => a.start),
      ...meals.filter((m) => !m.used && m.at > t).map((m) => m.at),
      bed
    );
    const prev = blocks[blocks.length - 1];
    const kinds = Object.entries(weights)
      .filter(([k]) => fits(KIND_HOURS[k], t) && durations[k][0] <= nextFixed - t && !(prev?.kind === k && k !== "leisure" && k !== "work"))
      .flatMap(([k, w]) => Array(w).fill(k));
    const kind = t >= bed - 90 || !kinds.length ? "leisure" : rng.pick(kinds);
    // Mesma coisa duas vezes no dia (fora lazer) não: ninguém toma sorvete às 15h e às 19h.
    const options = pools[kind].filter((o) => fits(o.hours, t) && fillFriends(o.label) !== prev?.label && (kind === "leisure" || !usedTemplates.has(o.label)));
    const template = rng.pick(options.length ? options : pools.leisure);
    usedTemplates.add(template.label);
    const { maxDur, ...entry } = materialize(rng, template, options.length ? kind : "leisure");
    const [dmin, dmax] = durations[entry.kind];
    let dur = Math.max(15, Math.min(nextFixed - t, rng.int(dmin, dmax)));
    // Tempo livre no celular é de minutinhos, não de horas.
    if (maxDur && ymd >= PHONE_TIME_FROM) dur = Math.min(dur, maxDur);
    t = push(t, dur, entry);
  }
  if (!showerDone && bed - t > 15) t = push(t, 20, { kind: "selfcare", label: "tomando banho", availability: "busy", place: "banheiro" });
  if (bed - t > 10) push(t, bed - t, { kind: "winddown", label: "deitada mexendo no celular antes de dormir", availability: "online", place: "quarto" });

  // Acontecimentos do dia (1 a 3), em blocos em que ela estava acordada e que combinam com o fato.
  const events = [];
  const nEvents = rng.int(1, 3);
  for (let tries = 0; events.length < nEvents && tries < 12; tries += 1) {
    const block = blocks[rng.int(1, Math.max(1, blocks.length - 1))];
    if (!block) continue;
    const pool = EVENTS.filter((e) => !e.kinds || e.kinds.includes(block.kind));
    const ev = rng.pick(pool);
    const friends = block.friends?.length ? block.friends : pickFriends(rng, 1, { femaleOnly: ev.female });
    const text = fillFriends(ev.text, friends);
    if (events.some((e) => e.text === text)) continue;
    events.push({ at: block.start + rng.int(0, Math.max(0, block.end - block.start - 5)), text, mood: ev.mood });
  }
  events.sort((a, b) => a.at - b.at);

  // Semente própria: as pausas não mudam o resto do dia já sorteado.
  return { date: ymd, weekday, wake, bed, blocks: addBreaks(blocks, seededRandom(`pausas:${ymd}`), seededRandom(`pausas-lazer:${ymd}`)), events };
}

export const fmtClock = (min) => {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
