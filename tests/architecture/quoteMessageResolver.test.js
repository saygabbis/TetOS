import { describe, expect, it } from "vitest";
import { ChatMessageIndex } from "../../src/integrations/whatsapp/chatMessageIndex.js";
import {
  messageExistsInQuoteContext,
  resolveVerifiedQuoteKey,
  scoreMessageIdSimilarity
} from "../../src/integrations/whatsapp/quoteMessageResolver.js";

const channel = "5516@s.whatsapp.net";

function seedIndex() {
  const index = new ChatMessageIndex();
  index.append({
    channelId: channel,
    messageId: "3EB0ABCDEF1234567890AA",
    actorId: "5516999999999",
    text: "Uai",
    isFromBot: false
  });
  index.append({
    channelId: channel,
    messageId: "3EB0F91A291E21535654C7",
    actorId: "teto",
    text: "olha esse gif",
    isFromBot: true
  });
  return index;
}

describe("scoreMessageIdSimilarity", () => {
  it("scores prefix and typo matches highly", () => {
    expect(scoreMessageIdSimilarity("3EB0ABCDEF1234567890", "3EB0ABCDEF1234567890AA")).toBeGreaterThan(
      0.8
    );
    expect(
      scoreMessageIdSimilarity("3EB0ABCDEF1234567890AA", "3EB0ABCDEF1234567890AB")
    ).toBeGreaterThan(0.7);
    expect(scoreMessageIdSimilarity("TOTALMENTE_ERRADO", "3EB0ABCDEF1234567890AA")).toBe(0);
  });
});

describe("resolveVerifiedQuoteKey", () => {
  it("returns exact id when present in index", () => {
    const chatMessageIndex = seedIndex();
    const result = resolveVerifiedQuoteKey({
      channelId: channel,
      remoteJid: channel,
      quoteId: "3EB0ABCDEF1234567890AA",
      chatMessageIndex
    });
    expect(result.reason).toBe("exact");
    expect(result.messageId).toBe("3EB0ABCDEF1234567890AA");
    expect(result.quoteKey?.id).toBe("3EB0ABCDEF1234567890AA");
  });

  it("resolves truncated id to closest known message", () => {
    const chatMessageIndex = seedIndex();
    const result = resolveVerifiedQuoteKey({
      channelId: channel,
      remoteJid: channel,
      quoteId: "3EB0ABCDEF1234567890",
      chatMessageIndex
    });
    expect(result.reason).toBe("closest_id");
    expect(result.messageId).toBe("3EB0ABCDEF1234567890AA");
  });

  it("drops quote when id is too far from history", () => {
    const chatMessageIndex = seedIndex();
    const result = resolveVerifiedQuoteKey({
      channelId: channel,
      remoteJid: channel,
      quoteId: "AC9999999999999999999999",
      chatMessageIndex
    });
    expect(result.quoteKey).toBeNull();
    expect(result.reason).toBe("not_found");
  });

  it("maps numeric user id to latest message", () => {
    const chatMessageIndex = seedIndex();
    const result = resolveVerifiedQuoteKey({
      channelId: channel,
      remoteJid: channel,
      quoteId: "5516999999999",
      chatMessageIndex
    });
    expect(result.reason).toBe("user_id_map");
    expect(result.messageId).toBe("3EB0ABCDEF1234567890AA");
  });

  it("accepts wa cache when index row is missing", () => {
    const getWaMessageById = (id) =>
      id === "AC1234567890ABCDEF"
        ? { key: { id, fromMe: false }, message: { conversation: "cache only" } }
        : null;
    const result = resolveVerifiedQuoteKey({
      channelId: channel,
      remoteJid: channel,
      quoteId: "AC1234567890ABCDEF",
      chatMessageIndex: new ChatMessageIndex(),
      getWaMessageById
    });
    expect(result.reason).toBe("exact");
    expect(result.messageId).toBe("AC1234567890ABCDEF");
  });
});

describe("messageExistsInQuoteContext", () => {
  it("detects index and wa cache", () => {
    const chatMessageIndex = seedIndex();
    expect(
      messageExistsInQuoteContext(channel, "3EB0F91A291E21535654C7", { chatMessageIndex })
    ).toBe(true);
    expect(
      messageExistsInQuoteContext(channel, "INEXISTENTE", {
        chatMessageIndex,
        getWaMessageById: () => null
      })
    ).toBe(false);
  });
});
