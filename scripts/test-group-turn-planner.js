import assert from "node:assert/strict";
import {
  planGroupTurnSegments,
  shouldSplitGroupSegment,
  isGroupPriorityEntry
} from "../src/integrations/whatsapp/groupTurnPlanner.js";
import {
  buildOutgoingQuoteKey,
  shouldQuoteOutgoing
} from "../src/integrations/whatsapp/messageContext.js";

function entry(overrides = {}) {
  return {
    userId: "111",
    message: "oi",
    messageKey: { id: "a1", remoteJid: "g@g.us" },
    ts: 1000,
    ...overrides
  };
}

// mesmo usuário, rajada curta → um segmento
const burst = planGroupTurnSegments([
  entry({ message: "a", ts: 1000, messageKey: { id: "1" } }),
  entry({ message: "b", ts: 1500, messageKey: { id: "2" } })
]);
assert.equal(burst.length, 1);
assert.equal(burst[0].message, "a\nb");
assert.equal(burst[0].batchedCount, 2);

// reply à Teto de outra pessoa → segmento separado
const split = planGroupTurnSegments([
  entry({ userId: "111", message: "qual a boa", ts: 1000, messageKey: { id: "1" } }),
  entry({
    userId: "222",
    pushName: "Kevin",
    message: "eu perguntei primeiro",
    isReplyToBot: true,
    ts: 3000,
    messageKey: { id: "2", participant: "222@s.whatsapp.net" }
  })
]);
assert.equal(split.length, 2);
assert.equal(split[1].message, "eu perguntei primeiro");
assert.equal(split[1].userId, "222");

// multi-speaker mesmo contexto
const multi = planGroupTurnSegments([
  entry({ userId: "111", pushName: "A", message: "teto vem", ts: 1000, isDirectMention: true }),
  entry({ userId: "222", pushName: "B", message: "sim", ts: 2000, groupEngagementActive: true })
]);
assert.equal(multi.length, 1);
assert.ok(multi[0].segmentMultiSpeaker);
assert.ok(multi[0].message.includes("[A]:"));
assert.ok(multi[0].message.includes("[B]:"));
assert.equal(isGroupPriorityEntry({ isDirectMention: true }), true);
assert.equal(isGroupPriorityEntry({ groupAddressKind: "contextual" }), true);
assert.equal(isGroupPriorityEntry({ groupEngagementActive: true }), false);

const prioritySeg = planGroupTurnSegments([
  entry({ userId: "111", message: "teto!", ts: 1000, groupAddressKind: "contextual", isDirectMention: true })
]);
assert.equal(prioritySeg[0].groupPriorityAddress, true);

assert.equal(shouldSplitGroupSegment(entry({ ts: 1000 }), entry({ userId: "222", isReplyToBot: true, ts: 2000 })), true);

// quote key em grupo sem participant
const key = buildOutgoingQuoteKey(
  { id: "msg1", remoteJid: "123@g.us", fromMe: false },
  "123@g.us",
  { participantId: "5511999999999", participantJid: "5511999999999@s.whatsapp.net" }
);
assert.equal(key.participant, "5511999999999@s.whatsapp.net");

assert.equal(shouldQuoteOutgoing({ messageKey: { id: "x" }, isReplyToBot: true }), true);
assert.equal(shouldQuoteOutgoing({ messageKey: { id: "x" }, quotedMessageId: "abc" }), true);
assert.equal(shouldQuoteOutgoing({ messageKey: { id: "x" }, batchedCount: 2 }), true);
assert.equal(shouldQuoteOutgoing({ messageKey: { id: "x" }, isGroup: true }), false);
assert.equal(shouldQuoteOutgoing({ messageKey: { id: "x" }, preferQuoteReply: true }), false);

console.log("test-group-turn-planner: ok");
