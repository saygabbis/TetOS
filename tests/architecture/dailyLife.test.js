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
    set("2026-10-20T15:30:00-03:00");
    const av = life.availability({ chatId: "a" });
    expect(av.mode).toBe("busy");
    expect(av.activity).toBe("na aula de canto");
    expect(life.promptLines().join("\n")).toMatch(/Agora: na aula de canto/);
  });

  it("ocupada: a dona é vista antes, urgência encurta", () => {
    const { life } = make("2026-10-20T15:30:00-03:00");
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
