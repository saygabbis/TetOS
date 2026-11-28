import { describe, expect, it } from "vitest";
import { HABITS, Temperament } from "../../src/core/mind/temperament.js";

describe("temperamento dinâmico", () => {
  it("a mesma taxa varia ao longo do dia e entre dias, sempre perto do jeito normal", () => {
    const t0 = Date.UTC(2026, 10, 28, 12);
    let at = t0;
    const t = new Temperament({ now: () => at });
    const values = [];
    for (let h = 0; h < 72; h += 1) {
      at = t0 + h * 3_600_000;
      values.push(t.chance("sticker_only", 0.1, {}));
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(max - min).toBeGreaterThan(0.02); // não é fixo
    expect(min).toBeGreaterThan(0.1 * 0.15);
    expect(max).toBeLessThan(0.1 * 3);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.05);
    expect(mean).toBeLessThan(0.2);
  });

  it("é suave: minuto a minuto quase não muda", () => {
    let at = Date.UTC(2026, 10, 28, 15);
    const t = new Temperament({ now: () => at });
    const a = t.factor("typo");
    at += 60_000;
    expect(Math.abs(t.factor("typo") - a)).toBeLessThan(0.08);
  });

  it("cansada erra mais e se mete menos no grupo", () => {
    const at = Date.UTC(2026, 10, 28, 15);
    const tired = new Temperament({ now: () => at }).connect({ life: { mood: () => ({ energy: 0.15, valence: 0.5 }) } });
    const awake = new Temperament({ now: () => at }).connect({ life: { mood: () => ({ energy: 0.95, valence: 0.7 }) } });
    expect(tired.chance("typo", 0.08, HABITS.typo)).toBeGreaterThan(awake.chance("typo", 0.08, HABITS.typo));
    expect(tired.factor("group_join", HABITS.group_join)).toBeLessThan(awake.factor("group_join", HABITS.group_join));
  });

  it("base zero continua zero (desligado no .env é desligado)", () => {
    expect(new Temperament().chance("x", 0)).toBe(0);
  });
});
