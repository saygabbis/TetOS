import { GroupEngagementWindow, resolveSilenceScope } from "../src/core/channels/groupEngagementWindow.js";
import { assert, ok } from "./test-helpers.js";

const groupId = "120363@test@g.us";
const userA = "5516111111111";
const userB = "5516222222222";
const TTL = 120_000;

const window = new GroupEngagementWindow({ ttlMs: TTL, muteMs: 60_000 });
let now = Date.now();

assert(!window.isActive(groupId, userA, now), "início sem janela");
window.touch(groupId, userA, now);
assert(window.isActive(groupId, userA, now + 30_000), "após menção fica ativo");
assert(!window.isActive(groupId, userB, now), "janela é por usuário");

const short = new GroupEngagementWindow({ ttlMs: 50, muteMs: 60_000 });
now = 5_000;
short.touch(groupId, userA, now);
assert(short.isActive(groupId, userA, now + 10), "ativo logo após touch");
assert(!short.isActive(groupId, userA, now + 60), "expira após ttl");

short.touch(groupId, userA, now + 100);
assert(short.isActive(groupId, userA, now + 120), "touch reseta timer");
assert(short.isActive(groupId, userA, now + 140), "mensagens seguidas mantêm janela");
assert(!short.isActive(groupId, userA, now + 200), "expira se parar de falar");

window.touch(groupId, userA, now);
assert(window.isActive(groupId, userA, now), "touch ativo antes de clear");
assert(window.clear(groupId, userA), "clear remove janela do usuário");
assert(!window.isActive(groupId, userA, now), "inativo após clear");

window.touch(groupId, userA, now);
window.touch(groupId, userB, now + 1);
assert(window.clearGroup(groupId) >= 2, "clearGroup remove todos do canal");
assert(!window.isActive(groupId, userA, now), "userA inativo após clearGroup");
assert(!window.isActive(groupId, userB, now + 1), "userB inativo após clearGroup");

assert(resolveSilenceScope(null, { isGroup: true }) === "channel", "calar padrão é canal");
assert(resolveSilenceScope("todos", { isGroup: true }) === "channel", "todos = canal");
assert(resolveSilenceScope("usuario", { isGroup: true }) === "user", "usuario = user");

window.touch(groupId, userA, now);
window.muteFromAgent(groupId, userA, { scope: "channel", ttlMs: 60_000, now });
assert(!window.isActive(groupId, userA, now), "mute limpa janela");
assert(window.isMuted(groupId, userA, now + 1_000), "mute bloqueia menção");
assert(window.isMuted(groupId, userB, now + 1_000), "mute de canal afeta todos");
assert(!window.isMuted(groupId, userA, now + 61_000), "mute expira após ttl");

ok("test-group-engagement-window");
