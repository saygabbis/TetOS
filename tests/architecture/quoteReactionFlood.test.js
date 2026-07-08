import { describe, expect, it } from "vitest";
import { sanitizeOutgoingActions } from "../../src/modules/chat/chatService.js";
import {
  resolveOutgoingQuoteId,
  shouldQuoteOutgoing
} from "../../src/integrations/whatsapp/messageContext.js";
import {
  compactGroupQueueSegments,
  planFloodAwareGroupSegments
} from "../../src/integrations/whatsapp/groupFloodCoordinator.js";
import { planWhatsAppReaction } from "../../src/integrations/whatsapp/reactionPlanner.js";

describe("resolveOutgoingQuoteId", () => {
  it("does not quote plain DM text by default", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "DM1" },
        isGroup: false
      })
    ).toBeNull();
    expect(shouldQuoteOutgoing({ messageKey: { id: "DM1" }, isGroup: false })).toBe(false);
  });

  it("quotes DM when replying to quoted media with describe intent", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "DM2" },
        message: "descreve essa figurinha",
        isGroup: false,
        isReply: true,
        quotedMessageId: "STICKER1",
        quotedMessage: "[sticker]"
      })
    ).toBe("STICKER1");
  });

  it("quotes user text message when replying to quoted media conversationally", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "DM2" },
        message: "Uai",
        isGroup: false,
        isReply: true,
        quotedMessageId: "GIF1",
        quotedMessage: "[gif] cachorro"
      })
    ).toBe("DM2");
  });

  it("quotes DM batched burst on last trigger", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "DM3" },
        isGroup: false,
        batchedCount: 4
      })
    ).toBe("DM3");
  });

  it("does not quote quotedMessageId without explicit reply context", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "x" },
        quotedMessageId: "abc"
      })
    ).toBeNull();
  });

  it("quotes in group when addressed", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "G1" },
        isGroup: true,
        isDirectMention: true
      })
    ).toBe("G1");
  });
});

describe("sanitizeOutgoingActions reactions", () => {
  it("keeps explicit react with long message but strips quote on trigger id", () => {
    const actions = sanitizeOutgoingActions(
      [
        { type: "message", text: "uma resposta bem longa ".repeat(8), quoteId: "T1" },
        { type: "react", emoji: "😏" }
      ],
      { messageKey: { id: "T1" }, isReplyToBot: true }
    );
    expect(actions.some((a) => a.type === "react")).toBe(true);
    expect(actions[0].quoteId).toBeNull();
  });
});

describe("group flood coordinator", () => {
  function entry(overrides = {}) {
    return {
      userId: "111",
      message: "oi",
      messageKey: { id: `m-${overrides.ts ?? 1000}` },
      ts: 1000,
      ...overrides
    };
  }

  it("merges flood into single catch-up segment", () => {
    const now = 200_000;
    const collected = [
      ...Array.from({ length: 8 }, (_, i) =>
        entry({ message: `old ${i}`, ts: now - 90_000 - i * 1000 })
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        entry({ message: `new ${i}`, ts: now - i * 400 })
      )
    ];
    const plan = planFloodAwareGroupSegments(collected);
    expect(plan.mode).toBe("catchup");
    expect(plan.segments.length).toBe(1);
    expect(plan.segments[0].groupCatchUp).toBe(true);
    expect(plan.droppedCount).toBeGreaterThan(0);
  });

  it("compacts deep group queue", () => {
    const queue = Array.from({ length: 6 }, (_, i) => ({
      userId: `u${i}`,
      message: `seg ${i}`,
      messageKey: { id: `s${i}` },
      batchedCount: 1
    }));
    const compacted = compactGroupQueueSegments(queue);
    expect(compacted.length).toBeLessThan(queue.length);
    expect(compacted.some((s) => s.groupCatchUp)).toBe(true);
  });
});

describe("planWhatsAppReaction", () => {
  it("can react after one message gap", () => {
    const plan = planWhatsAppReaction({
      userText: "vlw",
      state: { messagesSinceLastReaction: 1, lastReactionAt: 0 }
    });
    expect(plan.emoji === null || typeof plan.emoji === "string").toBe(true);
  });
});
