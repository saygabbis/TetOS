import { describe, expect, it } from "vitest";
import { SleepCycle } from "../../src/core/life/SleepCycle.js";
import { SleepMessageBuffer } from "../../src/core/life/sleepMessageBuffer.js";
import { scoreSleepDisturbance } from "../../src/core/life/sleepDisturbanceDetect.js";
import { resolveOutgoingQuoteId } from "../../src/integrations/whatsapp/messageContext.js";

function makeSleepStore(initialSleep = {}) {
  const state = {
    sleep: {
      state: "deep_sleep",
      sleepDebt: 0,
      alarmHistory: [],
      ...initialSleep
    }
  };
  return {
    state,
    get() {
      return this.state;
    },
    patch(partial) {
      Object.assign(this.state, partial);
      if (partial.sleep) {
        this.state.sleep = { ...this.state.sleep, ...partial.sleep };
      }
    }
  };
}

describe("sleep disturbance", () => {
  it("scores caps + name + wake words highly", () => {
    const score = scoreSleepDisturbance("TETO ACORDA ACORDAAAA", { floodCount: 4 });
    expect(score).toBeGreaterThan(0.65);
  });

  it("wakes temporarily on strong disturbance", () => {
    const store = makeSleepStore();
    const cycle = new SleepCycle(store);
    const result = cycle.attemptDisturbanceWake({ score: 0.9, floodCount: 6 });
    expect(result?.event).toBe("disturbed_wake");
    expect(cycle.isAvailable()).toBe(true);
    expect(cycle.isTemporarilyAwake()).toBe(true);
  });

  it("returns to sleep after temporary wake expires", () => {
    const store = makeSleepStore({
      temporaryWakeUntil: new Date(Date.now() - 1000).toISOString()
    });
    const cycle = new SleepCycle(store);
    const ended = cycle.checkTemporaryWake();
    expect(ended?.event).toBe("disturbed_return");
    expect(cycle.isAsleep()).toBe(true);
  });

  it("stays available after a normal wake even while wakeDelayUntil is in the future", () => {
    const store = makeSleepStore({ state: "deep_sleep" });
    const events = [];
    const cycle = new SleepCycle(store, { bus: { emit: (name) => events.push(name) } });
    expect(cycle.isAvailable()).toBe(false);
    cycle.wake({ quality: 0.72, immediate: false });
    expect(cycle.sleep.wakeDelayUntil).toBeTruthy();
    expect(Date.parse(cycle.sleep.wakeDelayUntil)).toBeGreaterThan(Date.now());
    expect(cycle.isAvailable()).toBe(true);
    expect(events).toContain("sleep.available");
  });

  it("morning wake after disturbance is groggy", () => {
    const store = makeSleepStore({ disturbanceCount: 2, sleepDebt: 0.2 });
    const cycle = new SleepCycle(store);
    const result = cycle.wake({ quality: 0.6, immediate: true, disturbed: true });
    expect(result.state).toBe("groggy");
    expect(cycle.isAvailable()).toBe(true);
  });

  it("extends temporary wake timer and grogginess on continued interaction", () => {
    const until = new Date(Date.now() + 240_000).toISOString();
    const store = makeSleepStore({
      state: "drowsy",
      temporaryWakeUntil: until,
      tempWakeExtensionCount: 1,
      tempWakeGrogginess: 0.36
    });
    const cycle = new SleepCycle(store);
    const result = cycle.extendTemporaryWakeOnInteraction();
    expect(result?.extensions).toBe(2);
    expect(result?.grogginess).toBeGreaterThan(0.36);
    expect(Date.parse(cycle.sleep.temporaryWakeUntil)).toBeGreaterThan(Date.parse(until) - 5000);
  });
});

describe("sleep message buffer", () => {
  it("flushes consolidated catch-up entry", () => {
    const buf = new SleepMessageBuffer({ maxPerSession: 5 });
    buf.append("dm-1", { message: "oi", userId: "u1", messageKey: { id: "m1" } });
    buf.append("dm-1", { message: "cadê", userId: "u1", messageKey: { id: "m2" } });
    const flushed = buf.flush("dm-1");
    expect(flushed.sleepCatchUp).toBe(true);
    expect(flushed.sleepCatchUpCount).toBe(2);
    expect(flushed.message).toContain("oi");
    expect(flushed.messageKey.id).toBe("m2");
  });

  it("drains every pending session when she wakes", () => {
    const buf = new SleepMessageBuffer({ maxPerSession: 5 });
    buf.append("dm-1", { message: "oie", userId: "u1", remoteJid: "1@lid" });
    buf.append("dm-2", { message: "alô", userId: "u2", remoteJid: "2@lid" });
    const drained = buf.drainAll();
    expect(drained).toHaveLength(2);
    expect(drained.map((e) => e.message).sort()).toEqual(["alô", "oie"]);
    expect(buf.flush("dm-1")).toBeNull();
  });

  it("quotes on sleep catch-up", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "LAST" },
        sleepCatchUp: true,
        isGroup: false
      })
    ).toBe("LAST");
  });
});
