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

  it("quotes marked media when user asks to describe replied image", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "TXT1" },
        message: "descreve essa imagem",
        quotedMessageId: "IMG9",
        isReply: true,
        quotedMessage: "[imagem] gato",
        replyThreadContext: { quoted: { text: "[imagem] gato" } }
      })
    ).toBe("IMG9");
  });

  it("quotes user text when replying to image conversationally", () => {
    expect(
      resolveOutgoingQuoteId({
        messageKey: { id: "TXT1" },
        message: "achei lindo",
        quotedMessageId: "IMG9",
        isReply: true,
        quotedMessage: "[imagem] gato",
        replyThreadContext: { quoted: { text: "[imagem] gato" } }
      })
    ).toBe("TXT1");
  });
});

describe("sanitizeOutgoingActions quote targets", () => {
  it("keeps quote to replied media id when explicitly set on action", () => {
    const actions = sanitizeOutgoingActions(
      [{ type: "message", text: "achei lindo", quoteId: "IMG9" }],
      {
        messageKey: { id: "TXT1" },
        quotedMessageId: "IMG9",
        isReply: true,
        recentHistory: [{ messageId: "IMG9" }, { messageId: "TXT1" }]
      }
    );
    expect(actions[0].quoteId).toBe("IMG9");
  });

  it("keeps quote on incoming message for conversational reply", () => {
    const actions = sanitizeOutgoingActions(
      [{ type: "message", text: "uai o que foi", quoteId: "TXT1" }],
      {
        messageKey: { id: "TXT1" },
        quotedMessageId: "GIF1",
        isReply: true,
        recentHistory: [{ messageId: "GIF1" }, { messageId: "TXT1" }]
      }
    );
    expect(actions[0].quoteId).toBe("TXT1");
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
