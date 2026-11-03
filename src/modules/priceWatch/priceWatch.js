// Monitor de preço: `.monitorarpreco <produto>` procura nos sites, a pessoa escolhe as opções e ela
// fica olhando até mandarem parar — avisa no mesmo chat quando muda, acha parecido bem mais barato
// em outro lugar e manda um resumo por dia com o histórico.
import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { brl, describeTip, pickRelevant } from "./priceParsing.js";

const DAY = 86_400_000;
const MAX_POINTS = 600;
const PENDING_TTL_MS = 30 * 60_000;
const MAX_ACTIVE_PER_CHAT = 10;
const MAX_ITEMS = 10;
const MISSES_TO_WARN = 3;

const short = (s, n = 70) => (String(s).length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s));
const pctText = (p) => `${p > 0 ? "+" : ""}${p.toFixed(1).replace(".", ",")}%`;
const chatKeyOf = ({ platform, chatId }) => `${platform}:${chatId}`;

function dayKey(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function hourOf(ms, timeZone) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(ms));
}

/** Ponto de histórico → { ms, price, store }. Os dias do Buscapé (sem hora) contam como meio-dia. */
function pointsOf(item) {
  const external = (item.external ?? []).map((d) => ({ ms: Date.parse(`${d.date}T12:00:00-03:00`), price: d.price, store: d.store ?? null }));
  const own = (item.history ?? []).map((h) => ({ ms: Date.parse(h.t), price: h.p, store: null }));
  return [...external, ...own].filter((p) => Number.isFinite(p.ms) && p.price > 0).sort((a, b) => a.ms - b.ms);
}

export function itemStats(item, now = Date.now()) {
  const points = pointsOf(item);
  if (!points.length) return null;
  const pick = (list, better) => list.reduce((best, p) => (better(p.price, best.price) ? p : best), list[0]);
  const lowest = pick(points, (a, b) => a < b);
  const highest = pick(points, (a, b) => a > b);
  const windows = {};
  for (const days of [7, 30, 90, 180]) {
    const inWin = points.filter((p) => p.ms >= now - days * DAY);
    if (inWin.length && points[0].ms <= now - days * DAY * 0.8) windows[days] = pick(inWin, (a, b) => a < b);
  }
  const ownFirst = (item.history ?? [])[0];
  return {
    since: points[0].ms,
    lowest,
    highest,
    windows,
    changeSinceStart: ownFirst && item.price ? ((item.price - ownFirst.p) / ownFirst.p) * 100 : null,
    startPrice: ownFirst?.p ?? null
  };
}

export class PriceWatch {
  constructor({
    path = null,
    sources,
    now = () => Date.now(),
    timeZone = "America/Sao_Paulo",
    intervalMs = 3 * 60 * 60_000,
    digestHour = 10,
    changeAlertPct = 1,
    cheaperElsewherePct = 8,
    commandPrefix = ".",
    logger = console
  } = {}) {
    this.path = path;
    this.sources = sources;
    this.now = now;
    this.timeZone = timeZone;
    this.intervalMs = intervalMs;
    this.digestHour = digestHour;
    this.changeAlertPct = changeAlertPct;
    this.cheaperElsewherePct = cheaperElsewherePct;
    this.prefix = commandPrefix;
    this.log = logger;
    this.senders = {};
    this.timer = null;
    this.busy = false;
    this.state = { nextId: 1, watches: [], pending: {}, ...(path ? readJson(path, {}) : {}) };
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.state);
  }

  registerSender(platform, fn) {
    this.senders[platform] = fn;
  }

  fmtDate(ms) {
    const opts = { timeZone: this.timeZone, day: "2-digit", month: "2-digit" };
    if (dayKey(ms, this.timeZone).slice(0, 4) !== dayKey(this.now(), this.timeZone).slice(0, 4)) opts.year = "2-digit";
    return new Intl.DateTimeFormat("pt-BR", opts).format(ms);
  }

  watchesOf(ctx, { activeOnly = true } = {}) {
    const key = chatKeyOf(ctx);
    return this.state.watches.filter((w) => chatKeyOf(w.chat) === key && (!activeOnly || w.active));
  }

  // ───────────────────────── comandos ─────────────────────────

  help() {
    const p = `${this.prefix}monitorarpreco`;
    return [
      "*monitor de preço* 💸",
      `${p} <produto> — procuro nos sites e te mando as opções`,
      "aí você responde com os números (ex: 1 3 5) ou *todos*",
      `${p} lista — o que tô monitorando aqui`,
      `${p} ver <nº> — preço agora, menor/maior, histórico e links`,
      `${p} checar <nº> — olho agora em vez de esperar`,
      `${p} parar <nº|todos> — paro de olhar`,
      "",
      `olho a cada ${Math.round(this.intervalMs / 60_000 / 60)}h, aviso aqui quando muda e mando um resumo por dia`
    ].join("\n");
  }

  /**
   * `.monitorarpreco …` (o texto depois do comando). ctx: { platform, chatId, userId, isGroup }.
   * `ctx.say(text)`: recado enquanto procura (a busca leva uns segundos).
   */
  async command(args, ctx) {
    const raw = String(args ?? "").trim();
    const [verb, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    const v = (verb ?? "").toLowerCase();
    if (!raw || v === "ajuda" || v === "help") {
      const list = this.watchesOf(ctx);
      return list.length ? `${this.help()}\n\n${this.formatList(ctx)}` : this.help();
    }
    if (v === "lista" || v === "listar") return this.formatList(ctx);
    if (v === "ver" || v === "detalhe" || v === "historico" || v === "histórico") return this.formatDetail(ctx, arg);
    if (v === "parar" || v === "pare" || v === "cancelar") return this.stop(ctx, arg);
    if (v === "checar" || v === "atualizar") return this.checkNow(ctx, arg);
    if (v === "escolher" || v === "escolho") return (await this.choose(arg, ctx)) ?? "não tem busca aberta aqui. manda o produto primeiro";
    return this.searchOptions(raw, ctx);
  }

  async searchOptions(query, ctx) {
    if (query.length < 3) return "manda o nome do produto, tipo: .monitorarpreco elegoo saturn 4 ultra";
    if (this.watchesOf(ctx).length >= MAX_ACTIVE_PER_CHAT) return `já tô olhando ${MAX_ACTIVE_PER_CHAT} produtos aqui. para algum antes (${this.prefix}monitorarpreco parar <nº>)`;
    await ctx.say?.(`procurando *${short(query, 60)}* nos sites, já te mando 🔎`);
    const { offers, errors } = await this.sources.search(query);
    const options = pickRelevant(query, offers, { max: 12 });
    const failed = [...new Set(errors.map((e) => this.sources.sources?.[e.source]?.label ?? e.source))];
    if (!options.length) {
      return `não achei nada parecido com *${short(query, 60)}*${failed.length ? ` (não consegui olhar: ${failed.join(", ")})` : ""}. tenta com outras palavras, tipo só marca e modelo`;
    }
    this.state.pending[chatKeyOf(ctx)] = { query, options, by: ctx.userId ?? null, at: this.now() };
    this.save();
    const lines = options.map((o, i) => `*${i + 1}.* ${this.optionLine(o)}`);
    return [
      `achei isso pra *${short(query, 60)}*:`,
      "",
      ...lines,
      "",
      "manda os números do que quer que eu monitore (pode vários: 1 3 5) ou *todos*",
      failed.length ? `(não consegui olhar: ${failed.join(", ")})` : null
    ]
      .filter((l) => l !== null)
      .join("\n");
  }

  optionLine(o) {
    const extra = [
      o.originalPrice ? `de ${brl(o.originalPrice)}` : null,
      o.sold,
      o.rating ? `⭐${o.rating}` : null,
      o.note
    ].filter(Boolean);
    return `${short(o.title)} — ${o.store} — *${brl(o.price)}*${extra.length ? ` (${extra.join(" · ")})` : ""}\n${o.url}`;
  }

  /** Resposta com números depois da lista ("1 3", "2, 5 e 7", "todos"). null = não era isso. */
  async handleSelection(text, ctx) {
    const pending = this.state.pending[chatKeyOf(ctx)];
    if (!pending || this.now() - pending.at > PENDING_TTL_MS) return null;
    const t = String(text ?? "").trim().toLowerCase();
    if (!/^(todos|todas|tudo|(\d{1,2}\s*(,|e|\s)\s*)*\d{1,2})$/.test(t)) return null;
    return this.choose(t, ctx);
  }

  async choose(text, ctx) {
    const key = chatKeyOf(ctx);
    const pending = this.state.pending[key];
    if (!pending || this.now() - pending.at > PENDING_TTL_MS) return null;
    const t = String(text ?? "").trim().toLowerCase();
    const picked = /^(todos|todas|tudo)$/.test(t)
      ? pending.options
      : [...new Set((t.match(/\d+/g) ?? []).map(Number))].map((n) => pending.options[n - 1]).filter(Boolean);
    if (!picked.length) return `esses números não tão na lista (vai de 1 a ${pending.options.length})`;
    delete this.state.pending[key];
    const at = new Date(this.now()).toISOString();
    const watch = {
      id: this.state.nextId++,
      chat: { platform: ctx.platform, chatId: ctx.chatId, userId: ctx.userId ?? null, isGroup: Boolean(ctx.isGroup) },
      query: pending.query,
      createdAt: at,
      createdBy: ctx.userId ?? null,
      active: true,
      lastCheckAt: this.now(),
      lastDigestDay: dayKey(this.now(), this.timeZone),
      items: picked.slice(0, MAX_ITEMS).map((o) => ({
        key: o.key,
        source: o.source,
        kind: o.kind,
        title: o.title,
        store: o.store,
        url: o.url,
        note: o.note ?? null,
        price: o.price,
        originalPrice: o.originalPrice ?? null,
        misses: 0,
        history: [{ t: at, p: o.price }],
        external: []
      })),
      pool: pending.options.filter((o) => !picked.includes(o)).map(poolEntry),
      alerted: {},
      outbox: []
    };
    await this.refreshProductPages(watch, { force: true });
    this.state.watches.push(watch);
    this.save();
    return `fechado! tô monitorando *${short(watch.query, 60)}* (nº ${watch.id}) 👀\n\n${this.formatWatch(watch)}\n\n${this.footer()}`;
  }

  footer() {
    return `te aviso aqui quando mudar. ${this.prefix}monitorarpreco ver <nº> pra ver tudo, ${this.prefix}monitorarpreco parar <nº> pra parar`;
  }

  stop(ctx, arg) {
    const list = this.watchesOf(ctx);
    if (!list.length) return "não tô monitorando nada aqui";
    const targets = /^(todos|todas|tudo)$/i.test(arg) ? list : list.filter((w) => String(w.id) === String(arg).replace(/\D/g, ""));
    if (!targets.length) return `qual? ${list.map((w) => `${w.id} (${short(w.query, 30)})`).join(", ")}`;
    for (const w of targets) {
      w.active = false;
      w.stoppedAt = new Date(this.now()).toISOString();
    }
    this.save();
    const summary = targets.map((w) => {
      const best = cheapest(w);
      return `• ${short(w.query, 50)} (nº ${w.id})${best ? ` — último menor: ${brl(best.price)} na ${best.store}` : ""}`;
    });
    return `parei de olhar:\n${summary.join("\n")}`;
  }

  findWatch(ctx, arg) {
    const list = this.watchesOf(ctx);
    if (!arg && list.length === 1) return list[0];
    const id = String(arg ?? "").replace(/\D/g, "");
    return list.find((w) => String(w.id) === id) ?? null;
  }

  formatList(ctx) {
    const list = this.watchesOf(ctx);
    if (!list.length) return `não tô monitorando nada aqui. manda ${this.prefix}monitorarpreco <produto>`;
    const lines = list.map((w) => {
      const best = cheapest(w);
      const since = this.fmtDate(Date.parse(w.createdAt));
      return `*${w.id}.* ${short(w.query, 50)} — ${w.items.length} opção(ões)${best ? `, menor agora ${brl(best.price)} (${best.store})` : ""} · desde ${since}`;
    });
    return `tô monitorando aqui:\n${lines.join("\n")}`;
  }

  formatDetail(ctx, arg) {
    const w = this.findWatch(ctx, arg);
    if (!w) return this.watchesOf(ctx).length ? `qual nº? ${this.formatList(ctx)}` : "não tô monitorando nada aqui";
    return `*${short(w.query, 60)}* (nº ${w.id}) — olhando desde ${this.fmtDate(Date.parse(w.createdAt))}\n\n${this.formatWatch(w, { full: true })}`;
  }

  /** Bloco de cada opção: preço agora, desconto, menor/maior com data, janelas de tempo e link. */
  formatWatch(w, { full = false } = {}) {
    const now = this.now();
    const blocks = [...w.items]
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
      .map((item, i) => {
        const st = itemStats(item, now);
        const lines = [`*${i + 1}.* ${short(item.title)} — ${item.store}`];
        const off = item.originalPrice && item.price ? Math.round((1 - item.price / item.originalPrice) * 100) : 0;
        lines.push(`   💰 agora *${brl(item.price)}*${off > 0 ? ` (de ${brl(item.originalPrice)} · -${off}%)` : ""}${item.misses >= MISSES_TO_WARN ? " ⚠️ sumiu da busca" : ""}${item.note ? ` · ${item.note}` : ""}`);
        if (st) {
          if (st.lowest.price !== st.highest.price) {
            lines.push(`   📉 menor: ${brl(st.lowest.price)} (${this.fmtDate(st.lowest.ms)}${st.lowest.store ? `, ${st.lowest.store}` : ""}) · 📈 maior: ${brl(st.highest.price)} (${this.fmtDate(st.highest.ms)})`);
          }
          const wins = Object.entries(st.windows).map(([d, p]) => `${d}d ${brl(p.price)} (${this.fmtDate(p.ms)})`);
          if (full && wins.length) lines.push(`   🗓️ menor em ${wins.join(" · ")}`);
          if (st.changeSinceStart !== null && Math.abs(st.changeSinceStart) >= 0.5) {
            lines.push(`   ${st.changeSinceStart < 0 ? "▼" : "▲"} ${pctText(st.changeSinceStart)} desde que comecei (${brl(st.startPrice)})`);
          }
          if (full) lines.push(`   histórico desde ${this.fmtDate(st.since)}`);
        }
        if (item.tip?.verdict) {
          const said = describeTip(item.tip.verdict);
          if (said) lines.push(`   🧾 Buscapé: ${said}${item.tip.median ? `, mediana ${brl(item.tip.median)}` : ""}`);
        }
        if (full && item.offers?.length > 1) {
          lines.push(`   🏪 ${item.offers.slice(0, 4).map((o) => `${o.store} ${brl(o.price)}`).join(" · ")}`);
        }
        lines.push(`   🔗 ${item.url}`);
        return lines.join("\n");
      });
    const elsewhere = this.cheaperElsewhere(w);
    if (elsewhere) blocks.push(`🔎 parecido mais barato que vi: ${short(elsewhere.title)} — ${elsewhere.store} — *${brl(elsewhere.price)}*\n${elsewhere.url}`);
    return blocks.join("\n\n");
  }

  /** Parecido (não escolhido) bem mais barato que a opção mais barata monitorada. */
  cheaperElsewhere(w) {
    const best = cheapest(w);
    if (!best || !w.pool?.length) return null;
    const limit = best.price * (1 - this.cheaperElsewherePct / 100);
    return [...w.pool].sort((a, b) => a.price - b.price).find((o) => o.price <= limit) ?? null;
  }

  // ───────────────────────── checagem ─────────────────────────

  async checkNow(ctx, arg) {
    const w = this.findWatch(ctx, arg);
    if (!w) return this.watchesOf(ctx).length ? `qual nº? ${this.formatList(ctx)}` : "não tô monitorando nada aqui";
    await ctx.say?.("olhando agora…");
    const events = await this.check(w);
    return events.length ? this.formatEvents(w, events) : `nada mudou em *${short(w.query, 60)}*.\n\n${this.formatWatch(w)}`;
  }

  /** Busca de novo, atualiza preços e histórico. Devolve o que vale avisar. */
  async check(w) {
    const { offers } = await this.sources.search(w.query, { allVariants: true });
    const at = new Date(this.now()).toISOString();
    const byKey = new Map(offers.map((o) => [o.key, o]));
    const events = [];
    for (const item of w.items) {
      const found = byKey.get(item.key);
      if (!found) {
        item.misses = (item.misses ?? 0) + 1;
        if (item.misses === MISSES_TO_WARN) events.push({ type: "gone", item });
        continue;
      }
      if ((item.misses ?? 0) >= MISSES_TO_WARN) events.push({ type: "back", item, price: found.price });
      item.misses = 0;
      const prev = item.price;
      const lowestBefore = itemStats(item, this.now())?.lowest?.price ?? prev;
      item.price = found.price;
      item.originalPrice = found.originalPrice ?? null;
      item.store = found.store ?? item.store;
      item.note = found.note ?? item.note ?? null;
      const last = item.history.at(-1);
      if (!last || last.p !== found.price || dayKey(Date.parse(last.t), this.timeZone) !== dayKey(this.now(), this.timeZone)) {
        item.history.push({ t: at, p: found.price });
        if (item.history.length > MAX_POINTS) item.history.splice(0, item.history.length - MAX_POINTS);
      }
      if (prev && Math.abs((found.price - prev) / prev) * 100 >= this.changeAlertPct) {
        events.push({ type: "change", item, prev, price: found.price, newLow: found.price < lowestBefore });
      }
    }
    // O que é parecido e não foi escolhido: vigia por baixa forte em outro lugar.
    const chosen = new Set(w.items.map((i) => i.key));
    w.pool = pickRelevant(w.query, offers, { max: 30 }).filter((o) => !chosen.has(o.key)).map(poolEntry);
    const elsewhere = this.cheaperElsewhere(w);
    if (elsewhere) {
      const before = w.alerted?.[elsewhere.key];
      if (!before || elsewhere.price < before * 0.98) {
        w.alerted = { ...(w.alerted ?? {}), [elsewhere.key]: elsewhere.price };
        events.push({ type: "elsewhere", offer: elsewhere, best: cheapest(w) });
      }
    }
    await this.refreshProductPages(w);
    w.lastCheckAt = this.now();
    this.save();
    return events;
  }

  /** Página de produto do Buscapé (1x por dia): histórico de ~40 dias, dica e as lojas. */
  async refreshProductPages(w, { force = false } = {}) {
    for (const item of w.items) {
      if (item.source !== "buscape" || item.kind !== "product" || !this.sources.buscapeProduct) continue;
      if (!force && item.productCheckedAt && this.now() - item.productCheckedAt < DAY) continue;
      const page = await this.sources.buscapeProduct(item.url);
      item.productCheckedAt = this.now();
      if (!page) continue;
      const known = new Map((item.external ?? []).map((d) => [d.date, d]));
      for (const d of page.history) known.set(d.date, d);
      item.external = [...known.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
      item.tip = page.tip;
      item.offers = page.offers.slice(0, 6);
    }
  }

  formatEvents(w, events) {
    const lines = [`💸 *${short(w.query, 60)}* (nº ${w.id})`];
    for (const e of events) {
      if (e.type === "change") {
        const pct = ((e.price - e.prev) / e.prev) * 100;
        lines.push(
          `${pct < 0 ? "▼ baixou" : "▲ subiu"} ${short(e.item.title, 60)} (${e.item.store}): ${brl(e.prev)} → *${brl(e.price)}* (${pctText(pct)})${e.newLow ? " — *menor preço que já vi!* 🎉" : ""}\n${e.item.url}`
        );
      } else if (e.type === "elsewhere") {
        lines.push(`🔎 achei parecido mais barato: ${short(e.offer.title, 60)} — ${e.offer.store} — *${brl(e.offer.price)}* (o mais barato que você escolheu tá ${brl(e.best.price)})\n${e.offer.url}`);
      } else if (e.type === "gone") {
        lines.push(`⚠️ ${short(e.item.title, 60)} (${e.item.store}) sumiu da busca — pode ter esgotado. último preço: ${brl(e.item.price)}`);
      } else if (e.type === "back") {
        lines.push(`✅ ${short(e.item.title, 60)} (${e.item.store}) voltou: *${brl(e.price)}*\n${e.item.url}`);
      }
    }
    return lines.join("\n\n");
  }

  formatDigest(w) {
    return `📊 resumo do dia — *${short(w.query, 60)}* (nº ${w.id})\n\n${this.formatWatch(w)}`;
  }

  async deliver(w, text) {
    const send = this.senders[w.chat.platform];
    if (!send) throw new Error(`sem envio pra ${w.chat.platform}`);
    await send({ chatId: w.chat.chatId, userId: w.chat.userId, isGroup: w.chat.isGroup, text });
  }

  /** Uma volta do relógio: entrega o que ficou pendente, checa quem venceu e manda o resumo do dia. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      const today = dayKey(now, this.timeZone);
      let checked = 0;
      for (const w of this.state.watches.filter((x) => x.active)) {
        while (w.outbox?.length) {
          try {
            await this.deliver(w, w.outbox[0]);
            w.outbox.shift();
          } catch {
            break;
          }
        }
        const texts = [];
        if (checked < 2 && now - (w.lastCheckAt ?? 0) >= this.intervalMs) {
          checked++;
          try {
            const events = await this.check(w);
            if (events.length) texts.push(this.formatEvents(w, events));
          } catch (error) {
            this.log.warn?.(`[preço] checagem nº ${w.id} falhou: ${error?.message ?? error}`);
          }
        }
        if (this.digestHour >= 0 && w.lastDigestDay !== today && hourOf(now, this.timeZone) >= this.digestHour) {
          w.lastDigestDay = today;
          texts.push(this.formatDigest(w));
        }
        for (const text of texts) {
          try {
            await this.deliver(w, text);
          } catch (error) {
            w.outbox = [...(w.outbox ?? []), text].slice(-5);
            this.log.warn?.(`[preço] aviso nº ${w.id} ficou pra depois: ${error?.message ?? error}`);
          }
        }
        if (texts.length) this.save();
      }
    } finally {
      this.busy = false;
    }
  }

  start({ everyMs = 5 * 60_000 } = {}) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.warn?.(`[preço] ${e?.message ?? e}`)), everyMs);
    this.timer.unref?.();
  }

  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

function poolEntry(o) {
  return { key: o.key, title: o.title, store: o.store, price: o.price, url: o.url, source: o.source };
}

function cheapest(w) {
  return w.items.filter((i) => i.price && (i.misses ?? 0) < MISSES_TO_WARN).sort((a, b) => a.price - b.price)[0] ?? null;
}

/** `.monitorarpreco …` / `.monitorar preço …` → texto depois do comando (ou null). */
export function parsePriceWatchCommand(text, prefix = ".") {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = String(text ?? "").trim().match(new RegExp(`^${esc}monitorar[\\s_-]?pre[cç]os?(?:\\s+([\\s\\S]*))?$`, "i"));
  return m ? (m[1] ?? "").trim() : null;
}
