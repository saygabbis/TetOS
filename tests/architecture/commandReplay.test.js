import { describe, expect, it } from "vitest";
import { isStaleHistoryReplay } from "../../src/integrations/whatsapp/processedCommandDeduper.js";
import { isLikelyStaticRaster } from "../../src/core/media/stickerAnimation.js";
import { detectAgentMediaReplyIntent } from "../../src/core/media/agentMediaReplyIntent.js";

describe("isStaleHistoryReplay", () => {
  it("keeps live notify commands", () => {
    expect(
      isStaleHistoryReplay("notify", { messageTimestamp: Math.floor(Date.now() / 1000) })
    ).toBe(false);
  });

  it("keeps recent group append (Baileys delivers some live msgs as append)", () => {
    const ts = Math.floor(Date.now() / 1000) - 20;
    expect(isStaleHistoryReplay("append", { messageTimestamp: ts })).toBe(false);
  });

  it("skips old history dump on reconnect", () => {
    const ts = Math.floor(Date.now() / 1000) - 60 * 30;
    expect(isStaleHistoryReplay("append", { messageTimestamp: ts })).toBe(true);
  });
});

describe("static raster shortcut", () => {
  it("does not treat missing files as static jpeg by extension", () => {
    expect(isLikelyStaticRaster("a.jpg")).toBe(false);
    expect(isLikelyStaticRaster("a.webp")).toBe(false);
    expect(isLikelyStaticRaster("a.gif")).toBe(false);
  });
});

describe("detectAgentMediaReplyIntent", () => {
  it("runs sticker on the current attachment without waiting for the LLM", () => {
    expect(
      detectAgentMediaReplyIntent("vira figurinha", {
        media: { type: "image" },
        messageKey: { id: "IMG1" }
      })
    ).toMatchObject({ command: "sticker", messageId: "IMG1", source: "self_media_intent" });
  });

  it("runs sticker on a quoted image", () => {
    expect(
      detectAgentMediaReplyIntent("faz uma figurinha", {
        isReply: true,
        quotedMessageId: "Q1",
        quotedMessage: "[image] gato"
      })
    ).toMatchObject({ command: "sticker", messageId: "Q1", source: "reply_intent" });
  });

  it("ignores chat that only mentions stickers", () => {
    expect(
      detectAgentMediaReplyIntent("adorei essa figurinha kkk", {
        media: { type: "image" },
        messageKey: { id: "IMG1" }
      })
    ).toBeNull();
    expect(
      detectAgentMediaReplyIntent("faz uma figurinha disso ai pfv", {
        media: { type: "image" },
        messageKey: { id: "IMG1" }
      })
    ).toMatchObject({ command: "sticker", messageId: "IMG1" });
  });
});
