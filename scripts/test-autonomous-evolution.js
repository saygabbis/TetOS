import { AutonomousEvolution } from "../src/core/life/AutonomousEvolution.js";
import { assert, ok } from "./test-helpers.js";

const evo = new AutonomousEvolution("./data/test-autonomous.json", {
  searchAdapter: { search: async () => [{ title: "Kasane Teto news", url: "https://example.com" }] },
  workerLlm: { generate: async () => "pensamento gerado pelo worker" }
});

const thought = await evo.generateSoloThoughtLlm({ emotion: { mood: "calma" }, life: { currentActivity: "mix" } });
assert(thought.source === "worker_llm", "uses generate not complete");
assert(thought.generated, "thought marked generated");

evo.plantInterest("synthv collab", "1h");
const matured = await evo.processDueHorizons(Date.now() + 2 * 3600000);
assert(matured.length >= 0, "horizons process");

ok("test-autonomous-evolution");
