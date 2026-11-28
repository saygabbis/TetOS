import { describe, expect, it } from "vitest";
import { DailyLife } from "../../src/core/life/dailyLife.js";
import { FeelingEngine } from "../../src/core/mind/feelings.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";
import { ResponseProcessor } from "../../src/modules/chat/responseProcessor.js";

const H = 3600_000;

function makeLife(start) {
  let now = new Date(start);
  const life = new DailyLife({ statePath: null, now: () => now });
  life.save = () => {};
  return { life, set: (d) => (now = new Date(d)), add: (ms) => (now = new Date(now.getTime() + ms)), get now() { return now; } };
}

describe("acordada à força (.tetos de madrugada)", () => {
  it("acorda, sabe quem acordou, fica zonza e irritada; o dia seguinte sente e vai passando", () => {
    const t = makeLife("2026-10-21T03:48:00-03:00");
    const woken = [];
    t.life.onWake = (w) => woken.push(w);
    const r = t.life.forceWake({ chatId: "c", by: "u1", byName: "Gabbis", isOwner: true, how: "te chamando direto (.tetos)" });
    expect(r?.woke).toBe(true);
    expect(woken[0]).toMatchObject({ by: "u1", isOwner: true, nth: 1 });
    expect(t.life.availability({ chatId: "c" }).mode).toBe("online");
    expect(t.life.grogginess()).toBeGreaterThan(0.9);
    const lines = t.life.promptLines().join("\n");
    expect(lines).toMatch(/a Gabbis te acordou/);
    expect(lines).toMatch(/NÃO acordou de boa/);
    // de novo, ainda acordada no mesmo chat: só estende, não conta outra vez
    expect(t.life.forceWake({ chatId: "c", by: "u1", isOwner: true })).toBeNull();

    // dia seguinte: cansada e lembra; o comentário muda com as horas
    const ownerLine = () => t.life.promptLines().find((l) => /te acordou/.test(l)) ?? "";
    t.set("2026-10-21T11:30:00-03:00");
    if (!t.life.isAsleep()) {
      const morning = ownerLine();
      expect(morning).toMatch(/Dormiu mal|Noite passada/);
      t.set("2026-10-21T19:30:00-03:00");
      expect(ownerLine()).not.toBe(morning);
    }
  });

  it("sentimentos: raiva passa rápido, emburrada e sono duram mais", () => {
    let now = Date.parse("2026-10-21T03:48:00-03:00");
    const f = new FeelingEngine(null, { now: () => now });
    f.feel("irritacao", 0.45, { cause: "a Gabbis me acordou" });
    f.feel("emburrada", 0.35, { cause: "a Gabbis me acordou" });
    f.feel("sono", 0.55, { cause: "a Gabbis me acordou" });
    now += 3 * H;
    expect(f.level("irritacao")).toBeLessThan(0.05);
    expect(f.level("emburrada")).toBeGreaterThan(0.1);
    expect(f.level("sono")).toBeGreaterThan(0.3);
    expect(f.mood().feelings.map((x) => x.name)).toContain("sono");
  });
});

describe("sentir(...) e erros de digitação", () => {
  it("sentir() vira ação invisível de sentimento", () => {
    const acts = parseActionCommands('mensagem("aff que chato") sentir("irritada", 0.3, "me acordaram")');
    expect(acts.find((a) => a.type === "feel")).toMatchObject({ feeling: "irritada", cause: "me acordaram" });
    expect(acts.find((a) => a.type === "message").text).toBe("aff que chato");
  });

  it("com sono erra bem mais e quase não corrige", () => {
    const p = new ResponseProcessor();
    let typos = 0;
    let fixes = 0;
    for (let i = 0; i < 200; i += 1) {
      p.imperfectionEvents = [];
      const out = p.imperfectActions([{ type: "message", text: "hmm quem tá me chamando agora nessa hora" }], { sleepy: 0.95 });
      if (out[0].text !== "hmm quem tá me chamando agora nessa hora") typos += 1;
      if (out.some((a) => /\*$/.test(a.text))) fixes += 1;
    }
    expect(typos).toBeGreaterThan(120);
    expect(fixes).toBeLessThan(typos * 0.4);
  });

  it("acordada normal: erro de vez em quando, e respeita conversa séria", () => {
    const p = new ResponseProcessor();
    let typos = 0;
    for (let i = 0; i < 400; i += 1) {
      p.imperfectionEvents = [];
      p.imperfectionCooldown = 0;
      const out = p.imperfectActions([{ type: "message", text: "nossa que legal isso que você falou" }], {});
      if (out[0].text !== "nossa que legal isso que você falou") typos += 1;
    }
    expect(typos).toBeGreaterThan(5);
    expect(typos).toBeLessThan(80);
    const serious = p.imperfectActions([{ type: "message", text: "calma, respira, tô aqui com você" }], { userMessage: "quero me matar", sleepy: 1 });
    expect(serious[0].text).toBe("calma, respira, tô aqui com você");
  });
});
