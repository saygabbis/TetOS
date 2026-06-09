import { slimMetaForStorage, repairShortTermMessage } from "../src/core/memory/slimMeta.js";
import { assert, ok } from "./test-helpers.js";

const bloated = {
  role: "user",
  content: "oi",
  meta: {
    userId: "dm-1",
    recentHistory: [{ role: "user", content: "x", meta: { recentHistory: [{ role: "user", content: "y" }] } }],
    brainSnapshot: { huge: "x".repeat(5000) },
    quotedMessage: "Quando o horário bater?"
  }
};

const slim = repairShortTermMessage(bloated);
assert(JSON.stringify(slim).length < 500, "bloated meta repaired");
assert(slim.meta.quotedMessage.includes("horário"), "keeps quote text");
assert(!slim.meta.recentHistory, "drops recentHistory");

ok("test-slim-meta");
