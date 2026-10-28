import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyLife, localParts, zonedDate } from "../../src/core/life/dailyLife.js";
import { planDay } from "../../src/core/life/dayPlanner.js";
import { DeferredInbox } from "../../src/integrations/whatsapp/conversation/deferredInbox.js";

const at = (iso) => new Date(iso);

describe("vida diária", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "life-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = (iso) => {
    let now = at(iso);
    const life = new DailyLife({ statePath: join(dir, "state.json"), now: () => now });
    return { life, set: (x) => { now = at(x); } };
  };

  it("converte horário local de SP certinho (inclusive depois da meia-noite)", () => {
    expect(zonedDate("2026-10-20", 25 * 60, "America/Sao_Paulo").toISOString()).toBe("2026-10-21T04:00:00.000Z");
    expect(localParts(at("2026-10-21T03:30:00Z"), "America/Sao_Paulo")).toMatchObject({ ymd: "2026-10-21", minutes: 30, weekday: 3 });
  });

  it("dia é o mesmo pra qualquer um e não tem buraco nem sobreposição", () => {
    const p = planDay("2026-10-24", { weekday: 6 });
    expect(planDay("2026-10-24", { weekday: 6 })).toEqual(p);
    for (let i = 1; i < p.blocks.length; i += 1) expect(p.blocks[i].start).toBeGreaterThanOrEqual(p.blocks[i - 1].end);
    expect(p.blocks.some((b) => b.label === "fazendo live no canal")).toBe(true);
  });

  it("de madrugada dorme; à tarde está fazendo algo do plano", () => {
    const { life, set } = make("2026-10-20T03:10:00-03:00");
    expect(life.availability({ chatId: "a" }).mode).toBe("asleep");
    expect(life.promptLines()[1]).toMatch(/dormindo/);
    set("2026-10-20T15:10:00-03:00");
    const av = life.availability({ chatId: "a" });
    expect(av.mode).toBe("busy");
    expect(av.activity).toBe("na aula de canto");
    expect(life.promptLines().join("\n")).toMatch(/Agora: na aula de canto/);
  });

  it("bloco longo de foco/rua tem pausas com o celular na mão", () => {
    for (const [ymd, weekday] of [["2026-10-22", 4], ["2026-10-23", 5], ["2026-10-24", 6]]) {
      const p = planDay(ymd, { weekday });
      // Nenhum trecho ocupado/na rua (fora banho) passa de 40 min sem pausa.
      for (const b of p.blocks) {
        if ((b.availability === "busy" || b.availability === "away") && b.kind !== "selfcare") {
          expect(b.end - b.start).toBeLessThanOrEqual(55);
        }
      }
      for (const pause of p.blocks.filter((b) => b.kind === "break")) {
        expect(pause.availability).toBe("online");
        expect(pause.during).toBeTruthy();
        expect(pause.end - pause.start).toBeLessThanOrEqual(10);
      }
    }
  });

  it("dias já vividos não mudam; só ganham as pausas", () => {
    const today = planDay("2026-10-22", { weekday: 4 }).blocks.filter((b) => b.kind !== "break");
    const labels = [...new Set(today.map((b) => b.label))];
    expect(labels).toContain("ensaiando vocal");
    expect(labels).toContain("no karaokê com a Momo e o Ted");
  });

  it("pausa: conversa na hora e o prompt diz do que ela pausou", () => {
    const { life } = make("2026-10-22T20:55:00-03:00");
    const av = life.availability({ chatId: "a" });
    expect(av.mode).toBe("online");
    expect(av.delayMs).toBe(0);
    expect(life.promptLines().join("\n")).toMatch(/no meio de: ensaiando vocal/);
  });

  it("fazendo algo com o celular do lado: responde em segundos, não em minutos", () => {
    const partial = planDay("2026-10-22", { weekday: 4 }).blocks.find((b) => b.availability === "partial");
    expect(partial).toBeTruthy();
    const { life } = make(zonedDate("2026-10-22", partial.start + 5, "America/Sao_Paulo").toISOString());
    const other = life.availability({ chatId: "x" });
    expect(other.mode).toBe("partial");
    expect(other.delayMs).toBeLessThanOrEqual(90_000);
    expect(life.availability({ chatId: "x", isOwner: true }).delayMs).toBeLessThanOrEqual(30_000);
  });

  it("celular na mão é coisa de minutinhos: lazer de verdade deixa ela entretida, com pausas", () => {
    for (const [ymd, weekday] of [["2026-10-28", 3], ["2026-10-31", 6], ["2026-11-02", 1]]) {
      const p = planDay(ymd, { weekday });
      const awake = p.blocks.reduce((sum, b) => sum + b.end - b.start, 0);
      const online = p.blocks.filter((b) => b.availability === "online").reduce((sum, b) => sum + b.end - b.start, 0);
      expect(online / awake).toBeLessThan(0.3);
      // Nenhum trecho "livre no celular" (fora acordar/dormir) passa de 40 min.
      for (const b of p.blocks.filter((x) => x.availability === "online" && !["waking", "winddown"].includes(x.kind))) {
        expect(b.end - b.start).toBeLessThanOrEqual(40);
      }
      for (const b of p.blocks.filter((x) => x.availability === "absorbed")) expect(b.end - b.start).toBeLessThanOrEqual(30);
    }
    const absorbed = planDay("2026-10-28", { weekday: 3 }).blocks.find((b) => b.availability === "absorbed");
    const { life } = make(zonedDate("2026-10-28", absorbed.start + 2, "America/Sao_Paulo").toISOString());
    const av = life.availability({ chatId: "x" });
    expect(av.mode).toBe("absorbed");
    expect(av.delayMs).toBeGreaterThanOrEqual(60_000);
    expect(life.availability({ chatId: "x", isOwner: true }).delayMs).toBeLessThanOrEqual(4 * 60_000);
  });

  it("ocupada: a dona é vista antes, urgência encurta", () => {
    const { life } = make("2026-10-20T15:10:00-03:00");
    const other = life.availability({ chatId: "x", isOwner: false }).delayMs;
    const owner = life.availability({ chatId: "x", isOwner: true }).delayMs;
    expect(owner).toBeLessThanOrEqual(other);
    expect(life.availability({ chatId: "x", urgency: 0.9 }).delayMs).toBeLessThanOrEqual(90_000);
  });

  it("acordar no susto vale só pro chat que acordou e no máximo 2x por noite", () => {
    const { life } = make("2026-10-20T03:10:00-03:00");
    expect(life.tryWake({ chatId: "dona", score: 0.6, isOwner: true })).toBeTruthy();
    expect(life.availability({ chatId: "dona" }).mode).toBe("online");
    expect(life.availability({ chatId: "outro" }).mode).toBe("asleep");
    expect(life.tryWake({ chatId: "b", score: 0.9 })).toBeTruthy();
    expect(life.tryWake({ chatId: "c", score: 0.9 })).toBeNull();
  });
});

describe("mensagens pra depois", () => {
  it("guarda em disco, junta a leva e só entrega na hora", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-"));
    let now = 1_000_000;
    const inbox = new DeferredInbox(join(dir, "inbox.json"), { now: () => now });
    inbox.append("s1", { message: "oi teto", userId: "u", ts: now }, { dueAt: now + 60_000, reason: "busy", activity: "gravando um cover" });
    inbox.append("s1", { message: "tá aí?", userId: "u", ts: now + 1000 }, { dueAt: now + 999_999 });
    expect(inbox.drainDue()).toEqual([]);
    now += 61_000;
    const [entry] = inbox.drainDue();
    expect(entry.message).toBe("oi teto\ntá aí?");
    expect(entry.deferredCatchUp).toEqual({ reason: "busy", activity: "gravando um cover", heldMinutes: 1 });
    expect(inbox.peekCount("s1")).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
