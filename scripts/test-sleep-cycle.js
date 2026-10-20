import "./isolatedData.js";
import { DailyLife } from "../src/core/life/dailyLife.js";
import { assert, ok } from "./test-helpers.js";

// 03:10 de uma terça: dormindo; a dona insistindo acorda só pro chat dela.
let now = new Date("2026-10-20T03:10:00-03:00");
const life = new DailyLife({ statePath: null, now: () => now });
life.save = () => {};
assert(life.isAsleep(), "dorme de madrugada");
assert(!life.sleep.getSnapshot().isAvailable, "indisponível dormindo");
assert(life.availability({ chatId: "dona" }).mode === "asleep", "modo asleep");
assert(!life.tryWake({ chatId: "estranho", score: 0.6, floodCount: 2, isOwner: false }), "estranho com pouca insistência não acorda");
assert(life.tryWake({ chatId: "dona", score: 0.6, floodCount: 1, isOwner: true }), "dona com urgência acorda");
assert(life.availability({ chatId: "dona" }).mode === "online", "acordada pro chat da dona");
assert(life.availability({ chatId: "outro" }).mode === "asleep", "os outros chats continuam esperando");

// 13h: acordada.
now = new Date("2026-10-20T13:00:00-03:00");
assert(!life.isAsleep(), "13h acordada");
assert(life.sleep.getSnapshot().isAvailable, "disponível de tarde");
ok("test-sleep-cycle");
