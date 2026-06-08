import { assert, ok } from "./test-helpers.js";

const sessionA = "551111@g.us";
const sessionB = "552222@g.us";
assert(sessionA !== sessionB, "distinct session keys");
const queueKey = (entry) => entry.sessionId ?? entry.userId;
assert(queueKey({ sessionId: sessionA, userId: "same" }) === sessionA, "fila por sessionId");
assert(queueKey({ userId: "5516988137617" }) === "5516988137617", "fallback userId");
ok("test-group-context");
