import { TimingEngine } from "../src/core/timing/TimingEngine.js";
import { assert, ok } from "./test-helpers.js";

const engine = new TimingEngine({ enabled: true });
const plan = engine.computePlan({
  hourOfDay: 14,
  emotion: { mood: "anxious", energy: 0.3, stress: 0.7, vulnerability: 0.6 },
  body: { hunger: 0.8, thirst: 0.7, physicalComfort: 0.2, vices: { coffee: 0.6, scroll: 0.7 } },
  sleep: { state: "underslept" },
  isGroup: true,
  hasMedia: true,
  media: { type: "video" },
  isDirectQuestion: true,
  isMention: true,
  userLikelyActive: false,
  trustBond: { intimacy: 0.8, trust: 0.75, rupture: 0.1, vulnerableReachOut: true },
  repetition: { shouldStayQuiet: false, overusedTopics: ["pao"] }
});
assert(plan.reasons.length >= 22, `esperado 22+ reasons, got ${plan.reasons.length}`);
ok(`test-timing-checks-count (${plan.reasons.length} reasons)`);
