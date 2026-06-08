import { TimingEngine } from "../src/core/timing/TimingEngine.js";

const engine = new TimingEngine({ enabled: true });
const plan = engine.computePlan({ hourOfDay: 14, emotion: { mood: "happy", energy: 0.8 }, sleep: { state: "awake" } });
console.assert(Array.isArray(plan.reasons) && plan.reasons.length > 0, "reasons");
console.log("test-timing-engine OK", plan.reasons.slice(0, 5));
