import { WorldContext } from "../src/core/life/WorldContext.js";
import { assert, ok } from "./test-helpers.js";

const world = new WorldContext("./data/test-world-v2.json", { journalAppend: () => {} });
world.state.lastTripEndedAt = new Date(Date.now() - 60 * 24 * 3600000).toISOString();

const trip = world.planTripFromInterest("quero viajar pro japão aprender cultura", { source: "test" });
assert(trip.currentLocation === "tokyo", "interest maps to tokyo");
assert(trip.isTraveling, "traveling flag");

world.returnHome();
const rare = world.considerAutonomousTrip({
  now: new Date("2026-06-10T12:00:00Z"),
  emotion: { mood: "curiosa" },
  life: { phase: "tarde" }
});
assert(rare === null || rare.currentLocation !== "sp" || rare.isTraveling === false, "rare roll ok");

ok("test-world-context-v2");
