import { describe, expect, it } from "vitest";
import {
  resolveOutgoingQuoteId,
  shouldQuoteOutgoing
} from "../../src/integrations/whatsapp/messageContext.js";
import { sanitizeOutgoingActions } from "../../src/modules/chat/chatService.js";
import {
  detectVisualTeaching,
  isMediaDescribeRequest
} from "../../src/core/media/visualKnowledgeIntent.js";
import { VisualKnowledgeStore } from "../../src/core/media/visualKnowledgeStore.js";

describe("resolveOutgoingQuoteId", () => {
  it("quotes inbound image message", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "IMG1" },
        media: { type: "image" }
      })
    ).toBe("IMG1");
    expect(shouldQuoteOutgoing({ messageKey: { id: "IMG1" }, media: { type: "sticker" } })).toBe(
      true
    );
  });

  it("quotes marked media when user replies to image", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "TXT1" },
        quotedMessageId: "IMG9",
        isReply: true,
        quotedMessage: "[imagem] gato",
        replyThreadContext: { quoted: { text: "[imagem] gato" } }
      })
    ).toBe("IMG9");
  });
});

describe("sanitizeOutgoingActions quote targets", () => {
  it("keeps quote to replied media id even if recent", () => {
    const actions = sanitizeOutgoingActions(
      [{ type: "message", text: "achei lindo", quoteId: "IMG9" }],
      {
        messageKey: { id: "TXT1" },
        quotedMessageId: "IMG9",
        recentHistory: [{ messageId: "IMG9" }, { messageId: "TXT1" }]
      }
    );
    expect(actions[0].quoteId).toBe("IMG9");
  });
});

describe("visual knowledge", () => {
  it("detects teaching and describe requests", () => {
    expect(detectVisualTeaching("isso sou eu, guarda")?.label).toBe("kasane_teto");
    expect(isMediaDescribeRequest("descreve essa imagem")).toBe(true);
  });

  it("matches learned vision signatures", () => {
    const store = new VisualKnowledgeStore("./data/test-visualKnowledge-match.json");
    store.learn({
      userId: "u1",
      label: "kasane_teto",
      visionText: "garota anime cabelo rosa twin drills baguete",
      taughtByText: "isso sou eu"
    });
    const hits = store.match("figurinha anime brocas rosa sorrindo", { userId: "u1" });
    expect(hits.length).toBeGreaterThan(0);
  });
});
