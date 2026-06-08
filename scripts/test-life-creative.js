import { createRuntime } from "../src/app/createRuntime.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const routine = runtime.brainOrchestrator?.life?.routine;
assert(routine, "routine generator present");
const day = routine.generateDay({ phase: "manha", isWeekend: false });
assert(Array.isArray(day.items) || Array.isArray(day.obligations) || day, "day plan generated");
ok("test-life-creative");
