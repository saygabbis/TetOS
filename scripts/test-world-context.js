import { WorldContext } from "../src/core/life/WorldContext.js";
import { assert, ok } from "./test-helpers.js";

const world = new WorldContext("./data/worldContext.json");
world.tick({ hour: 14 });
const snap = world.getSnapshot();
assert(snap.currentLocation, "has location");
assert(Array.isArray(snap.climateTags), "climate tags");
ok("test-world-context");
