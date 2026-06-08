import { BodyNeeds } from "../src/core/emotion/BodyNeeds.js";
import { TimingEngine } from "../src/core/timing/TimingEngine.js";
import { assert, ok } from "./test-helpers.js";

const body = new BodyNeeds("./data/test-body-needs.json");
body.tick({ hourOfDay: 14, activity: "idle" });
const state = body.getState();
assert(state.hunger >= 0, "hunger tracked");
const timing = new TimingEngine({ enabled: true });
const plan = timing.computePlan({ body: { ...state, hunger: 0.9 }, emotion: { mood: "neutral", energy: 0.5 } });
assert(plan.reasons.includes("hungry"), "hunger affects timing");
ok("test-body-needs");
