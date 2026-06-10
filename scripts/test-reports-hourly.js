import { DailyReportGenerator } from "../src/core/learning/dailyReportGenerator.js";
import { EventLedger } from "../src/core/learning/eventLedger.js";
import { BehaviorProfiler } from "../src/core/learning/behaviorProfiler.js";
import { FocusConfigStore } from "../src/core/learning/focusConfigStore.js";
import { assert, ok } from "./test-helpers.js";

const ledger = new EventLedger({ basePath: "./data/learning-ledger", timeZone: "America/Sao_Paulo" });
const profiler = new BehaviorProfiler("./data/behaviorProfiles.json");
const focus = new FocusConfigStore("./data/learningFocus.json");
const gen = new DailyReportGenerator({
  reportsPath: "./data/reports/daily",
  ledger,
  behaviorProfiler: profiler,
  focusStore: focus,
  timeZone: "America/Sao_Paulo",
  mindLogPath: "./data/mind-log"
});
assert(typeof gen.generateForDay === "function", "report generator ready");
ok("test-reports-hourly");
