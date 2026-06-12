import { createRuntime } from "../src/app/createRuntime.js";
import { assert, ok } from "./test-helpers.js";
import { isInSleepWindow, isPastWakeTime } from "../src/core/life/sleepSchedule.js";

const runtime = createRuntime();
const sleep = runtime.brainOrchestrator?.life?.sleep;
assert(sleep, "sleep cycle present");

sleep.store.patch({
  sleep: {
    state: "light_sleep",
    sleepDebt: 0,
    lastSleepAt: new Date().toISOString(),
    tonightPlan: { bedHour: 23, wakeHour: 7 },
    alarmHistory: [],
    wakeDelayUntil: null
  }
});

const woke = sleep.reconcileWithSchedule({
  timezone: "America/Sao_Paulo",
  rhythm: {},
  now: new Date("2026-06-12T16:00:00-03:00")
});
assert(woke?.state, "acorda fora da janela de sono (13h BRT)");
assert(sleep.getSnapshot().isAvailable, "disponivel apos reconciliar");

assert(!isInSleepWindow(13, 23, 7), "13h nao e janela de sono");
assert(isPastWakeTime(13, 23, 7), "13h ja passou da hora de acordar");

sleep.tick({ hourOfDay: 2, energy: 0.2, stress: 0.6, rhythm: {} });
const snap = sleep.getSnapshot();
assert(snap.state, "sleep state");
assert(typeof snap.isAvailable === "boolean", "availability in snapshot");

ok("test-sleep-cycle");
