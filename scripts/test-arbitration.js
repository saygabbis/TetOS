import { CandidateArbitrator } from "../src/core/brain/CandidateArbitrator.js";
import { createRuntime } from "../src/app/createRuntime.js";
import { assert, ok } from "./test-helpers.js";

const arb = new CandidateArbitrator();
const result = arb.run({
  life: { currentActivity: "ensaio", sleep: { isAvailable: true } },
  music: { pendingComment: "nova faixa" },
  timing: { shouldInitiateConversation: true, initiateReason: "3h gap" },
  trustBond: { vulnerableReachOut: true, trust: 0.8, intimacy: 0.7 }
}, { media: { type: "sticker" } });

assert(result.winner, "arbitration picks winner");
assert(result.winner.source === "trust", "trust wins over timing when vulnerable");
assert(result.candidates.length >= 3, "multiple candidates collected");

const runtime = createRuntime();
assert(runtime.brainOrchestrator?.arbitrator, "orchestrator has arbitrator");

ok("test-arbitration");
