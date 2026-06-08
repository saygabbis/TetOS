import { createRuntime } from "../src/app/createRuntime.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const sleep = runtime.brainOrchestrator?.life?.sleep;
assert(sleep, "sleep cycle present");
sleep.tick({ hourOfDay: 2, energy: 0.2, stress: 0.6 });
const snap = sleep.getSnapshot();
assert(snap.state, "sleep state");
assert(typeof snap.isAvailable === "boolean", "availability in snapshot");
ok("test-sleep-cycle");
