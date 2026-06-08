import { GroupMemoryStore } from "../src/core/memory/GroupMemoryStore.js";
import { assert, ok } from "./test-helpers.js";

const store = new GroupMemoryStore("./data/test-group-persist.ndjson", { maxEntries: 50 });
const channelId = "group:test-persist";
store.append({ channelId, userId: "alice", text: "lembra do projeto X", ts: new Date().toISOString() });
const recalled = store.recall(channelId, "projeto");
assert(recalled.length > 0, "triggered recall");
const ctx = store.byChannel(channelId, { limit: 10 });
assert(ctx.length >= 1, "persistent context");
ok("test-group-memory");
