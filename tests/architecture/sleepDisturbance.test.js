import { describe, expect, it } from "vitest";
import { scoreSleepDisturbance } from "../../src/core/life/sleepDisturbanceDetect.js";
import { resolveOutgoingQuoteId } from "../../src/integrations/whatsapp/inbound/messageContext.js";
import { DailyLife } from "../../src/core/life/dailyLife.js";

describe("sono perturbado", () => {
  it("CAPS + nome + 'acorda' pontua alto", () => {
    expect(scoreSleepDisturbance("TETO ACORDA ACORDAAAA", { floodCount: 4 })).toBeGreaterThan(0.65);
  });

  it("acordada no susto: volta a dormir quando o tempo acaba e estende se a conversa continua", () => {
    let now = new Date("2026-10-21T03:00:00-03:00");
    const life = new DailyLife({ statePath: null, now: () => now });
    life.save = () => {};
    expect(life.tryWake({ chatId: "c", score: 0.9, floodCount: 6 })).toBeTruthy();
    expect(life.availability({ chatId: "c" }).mode).toBe("online");
    now = new Date(now.getTime() + 8 * 60_000);
    life.extendWake("c");
    now = new Date(now.getTime() + 3 * 60_000);
    expect(life.availability({ chatId: "c" }).mode).toBe("online");
    now = new Date(now.getTime() + 20 * 60_000);
    expect(life.availability({ chatId: "c" }).mode).toBe("asleep");
  });

  it("cita a última mensagem ao responder o que chegou dormindo", () => {
    expect(resolveOutgoingQuoteId({ messageKey: { id: "LAST" }, sleepCatchUp: true, isGroup: false })).toBe("LAST");
  });
});
