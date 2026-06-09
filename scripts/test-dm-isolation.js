import "dotenv/config";
import { createRuntime } from "../src/app/createRuntime.js";
import {
  canonicalSessionId,
  canonicalUserId,
  dmUserId,
  isOwnerContact
} from "../src/core/channels/userActivity.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
const ownerPhone = runtime.defaults.learningTargetUserId || "5516988137617";
const ownerJid = "157947506229421@lid";
const friendJid = "131778236952767@lid";

runtime.defaults.ownerWaJids = [ownerJid];

const ownerBase = "157947506229421";
const friendBase = "131778236952767";

const ownerUserId = canonicalUserId(runtime, ownerBase, { remoteJid: ownerJid });
const friendUserId = canonicalUserId(runtime, friendBase, { remoteJid: friendJid });

assert(ownerUserId === dmUserId(ownerJid), "owner uses same dm id as everyone else");
assert(friendUserId === dmUserId(friendJid), "friend uses dm id");
assert(ownerUserId !== friendUserId, "owner and friend must not share user id");
assert(!isOwnerContact(runtime, friendJid, friendUserId), "friend is not owner");
assert(isOwnerContact(runtime, ownerJid, ownerUserId), "owner recognized by jid");

const ownerSession = canonicalSessionId(runtime, ownerUserId, { remoteJid: ownerJid });
const friendSession = canonicalSessionId(runtime, friendUserId, { remoteJid: friendJid });

assert(ownerSession !== friendSession, "sessions must differ");

runtime.shortTerm.clear(ownerSession);
runtime.shortTerm.clear(friendSession);
runtime.shortTerm.add({ role: "user", content: "fome amiga" }, ownerSession);
runtime.shortTerm.add({ role: "assistant", content: "pedindo pizza no teu lugar" }, ownerSession);

const ownerHistory = runtime.shortTerm.getAll(ownerSession);
const friendHistory = runtime.shortTerm.getAll(friendSession);

assert(ownerHistory.length === 2, "owner history kept");
assert(friendHistory.length === 0, "friend history empty — no leak");

assert(!ownerUserId.includes(ownerPhone) || ownerUserId.startsWith("dm-"), "owner memory not keyed by phone");

ok("test-dm-isolation");
