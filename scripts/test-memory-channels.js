import { GroupMemoryStore } from "../src/core/memory/GroupMemoryStore.js";
import { EpisodicMemoryStore } from "../src/core/memory/EpisodicMemoryStore.js";
import { assert, ok } from "./test-helpers.js";

const group = new GroupMemoryStore("./data/test-group-memory.ndjson", { maxEntries: 20 });
const episodic = new EpisodicMemoryStore("./data/test-episodic.ndjson");
group.append({ channelId: "group:g1", userId: "u1", text: "oi grupo", ts: new Date().toISOString() });
episodic.save({ userId: "u1", channelScope: "direct", summary: "dm msg", ts: new Date().toISOString() });
episodic.save({ userId: "u1", channelScope: "group:g1", summary: "group msg", ts: new Date().toISOString() });
const dm = episodic.retrieve({ userId: "u1", channelScope: "direct", limit: 5 });
const gr = episodic.retrieve({ userId: "u1", channelScope: "group:g1", limit: 5 });
assert(dm.every((e) => e.channelScope === "direct"), "dm isolated");
assert(gr.every((e) => e.channelScope === "group:g1"), "group isolated");
ok("test-memory-channels");
