import "dotenv/config";
import { createRuntime } from "../src/app/createRuntime.js";
import {
  isOwnerContact,
  isUserRecentlyActive,
  linkedUserIds,
  touchUserActivity
} from "../src/core/channels/userActivity.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const ownerJid = "157947506229421@lid";
const friendLid = "131778236952767";
const ownerDm = `dm-${ownerJid.replace(/@.+$/, "")}`;

runtime.defaults.ownerWaJids = [ownerJid];

// A mesma pessoa pode ter tel, LID e dm-* ligados — mas nunca outro contato nem chave de grupo.
const ownerLinked = linkedUserIds(runtime, ownerDm);
const ownerIds = new Set(ownerLinked);
assert(ownerLinked.includes(ownerDm), "owner liga a si mesma");
assert(ownerLinked.every((id) => !id.includes("::")), "sem chaves de grupo na identidade");
assert(!ownerIds.has(`dm-${friendLid}`) && !ownerIds.has(friendLid), "no cross-link between contacts");

const friendLinked = linkedUserIds(runtime, `dm-${friendLid}`);
assert(!friendLinked.some((id) => ownerIds.has(id)), "friend isolated");

assert(isOwnerContact(runtime, ownerJid, ownerDm), "owner contact detected");
assert(!isOwnerContact(runtime, `${friendLid}@lid`, `dm-${friendLid}`), "friend not owner");

touchUserActivity(runtime, ownerDm);
assert(isUserRecentlyActive(runtime, ownerDm, 600000), "owner dm marked active");
assert(!isUserRecentlyActive(runtime, `dm-${friendLid}`, 600000), "friend not marked by owner touch");

ok("test-user-activity");
