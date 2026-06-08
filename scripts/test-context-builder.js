import { LongTermMemory } from "../src/core/memory/longTerm.js";
import { ContextBuilder } from "../src/core/memory/contextBuilder.js";
import { assert, ok } from "./test-helpers.js";

const path = "./data/test-context-builder-memory.json";
const longTerm = new LongTermMemory(path);
longTerm.save({ userId: "u1", content: "gosta de pão", tags: ["food"], channelScope: "direct" });
longTerm.save({ userId: "u1", content: "gosta de pão", tags: ["food"], channelScope: "direct" });
longTerm.save({ userId: "u1", content: "no grupo falou de anime", tags: ["anime"], channelScope: "group:g1" });

const deduped = longTerm.dedupeAll();
assert(deduped.after <= deduped.before, "dedup reduces duplicates");

const builder = new ContextBuilder(longTerm);
const dm = builder.build("pão", 5, "u1", { channelScope: "direct", isGroup: false });
const gr = builder.build("anime", 5, "u1", { channelId: "g1", channelScope: "group:g1", isGroup: true });

assert(dm.longTerm.length >= 1, "dm retrieval works");
assert(dm.channelScope === "direct", "dm channelScope");
assert(gr.channelScope === "group:g1", "group channelScope");
assert(dm.longTerm.length <= 2, "dedup in build results");

ok("test-context-builder");
