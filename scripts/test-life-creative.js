import "./isolatedData.js";
import { planDay } from "../src/core/life/dayPlanner.js";
import { assert, ok } from "./test-helpers.js";

const a = planDay("2026-10-23", { weekday: 5 });
const b = planDay("2026-10-23", { weekday: 5 });
assert(JSON.stringify(a) === JSON.stringify(b), "mesmo dia → mesma vida (determinístico)");
assert(a.blocks.length >= 8, "dia com várias atividades");
assert(a.blocks.some((x) => /rolê de sexta/.test(x.label)), "sexta tem rolê");
for (let i = 1; i < a.blocks.length; i += 1) assert(a.blocks[i].start >= a.blocks[i - 1].end, "blocos não se sobrepõem");
assert(a.events.length >= 1 && a.events.length <= 3, "1 a 3 acontecimentos");
ok("test-life-creative");
