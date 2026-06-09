import { GroupEngagementWindow } from "../src/core/channels/groupEngagementWindow.js";
import { assert, ok } from "./test-helpers.js";

const groupId = "120363@test@g.us";
const userA = "5516111111111";
const userB = "5516222222222";
const TTL = 120_000;

const window = new GroupEngagementWindow({ ttlMs: TTL });
let now = Date.now();

assert(!window.isActive(groupId, userA, now), "início sem janela");
window.touch(groupId, userA, now);
assert(window.isActive(groupId, userA, now + 30_000), "após menção fica ativo");
assert(!window.isActive(groupId, userB, now), "janela é por usuário");

const short = new GroupEngagementWindow({ ttlMs: 50 });
now = 5_000;
short.touch(groupId, userA, now);
assert(short.isActive(groupId, userA, now + 10), "ativo logo após touch");
assert(!short.isActive(groupId, userA, now + 60), "expira após ttl");

short.touch(groupId, userA, now + 100);
assert(short.isActive(groupId, userA, now + 120), "touch reseta timer");
assert(short.isActive(groupId, userA, now + 140), "mensagens seguidas mantêm janela");
assert(!short.isActive(groupId, userA, now + 200), "expira se parar de falar");

ok("test-group-engagement-window");
