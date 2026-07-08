import { describe, expect, it } from "vitest";
import { describeMediaForPrompt } from "../../src/core/media/mediaHeuristics.js";
import { sanitizeOutgoingActions } from "../../src/modules/chat/chatService.js";
import { shouldQuoteOutgoing } from "../../src/integrations/whatsapp/messageContext.js";
import { detectImageGenerationIntent } from "../../src/core/media/imageGenerationIntent.js";

describe("reply and quote helpers", () => {
  it("shouldQuoteOutgoing when reply to bot", () => {
    expect(
      shouldQuoteOutgoing({
        messageKey: { id: "abc123" },
        isReplyToBot: true
      })
    ).toBe(true);
  });

  it("keeps quoteId when it matches trigger message on conversational reply", () => {
    const actions = sanitizeOutgoingActions(
      [{ type: "message", text: "blz", quoteId: "TRIG1" }],
      { messageKey: { id: "TRIG1" }, isReply: true, isReplyToBot: true }
    );
    expect(actions[0].quoteId).toBe("TRIG1");
  });

  it("allows react with short message", () => {
    const actions = sanitizeOutgoingActions(
      [
        { type: "message", text: "vlw", quoteId: null },
        { type: "react", emoji: "❤️" }
      ],
      { messageKey: { id: "X1" } }
    );
    expect(actions.some((a) => a.type === "react")).toBe(true);
  });
});

describe("media heuristics", () => {
  it("marks vision failure distinctly from pending", () => {
    const failed = describeMediaForPrompt({
      type: "sticker",
      visionAttempted: true,
      visionStatus: "failed"
    });
    expect(failed).toContain("falhou");

    const pending = describeMediaForPrompt({ type: "image", visionAttempted: false });
    expect(pending).toContain("pendente");
  });
});

describe("image generation intent", () => {
  it("detects natural language image requests", () => {
    const hit = detectImageGenerationIntent("Teto, gera uma imagem de gato astronauta");
    expect(hit?.prompt).toMatch(/gato astronauta/i);
  });

  it("ignores dot commands", () => {
    expect(detectImageGenerationIntent(".gerar gato")).toBeNull();
  });
});
