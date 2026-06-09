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

const ownerLinked = linkedUserIds(runtime, ownerDm);
assert(ownerLinked.length === 1 && ownerLinked[0] === ownerDm, "no cross-link between contacts");

const friendLinked = linkedUserIds(runtime, `dm-${friendLid}`);
assert(friendLinked.length === 1, "friend isolated");

assert(isOwnerContact(runtime, ownerJid, ownerDm), "owner contact detected");
assert(!isOwnerContact(runtime, `${friendLid}@lid`, `dm-${friendLid}`), "friend not owner");

touchUserActivity(runtime, ownerDm);
assert(isUserRecentlyActive(runtime, ownerDm, 600000), "owner dm marked active");
assert(!isUserRecentlyActive(runtime, `dm-${friendLid}`, 600000), "friend not marked by owner touch");

ok("test-user-activity");
