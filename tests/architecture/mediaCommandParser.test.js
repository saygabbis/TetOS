import { describe, expect, it } from "vitest";
import {
  formatWhatsAppHelpText,
  parseWhatsAppCommand
} from "../../src/integrations/whatsapp/mediaCommandParser.js";

describe("media command parser", () => {
  it("normalizes supported media command aliases", () => {
    expect(parseWhatsAppCommand(".sticker 10s")).toEqual({
      command: "sticker",
      args: ["10s"]
    });
    expect(parseWhatsAppCommand(".stiker")).toEqual({
      command: "sticker",
      args: []
    });
    expect(parseWhatsAppCommand(".otimizar")).toEqual({
      command: "optimize",
      args: []
    });
    expect(parseWhatsAppCommand(".remove-bg verde forte")).toEqual({
      command: "removebg",
      args: ["verde", "forte"]
    });
  });

  it("ignores non-command text and slash activation commands", () => {
    expect(parseWhatsAppCommand("oi .sticker")).toBeNull();
    expect(parseWhatsAppCommand("/teto-ativar")).toBeNull();
  });

  it("formats help text with the configured prefix", () => {
    expect(formatWhatsAppHelpText(".")).toMatch(/\.sticker/);
    expect(formatWhatsAppHelpText("!")).toMatch(/!toimg/);
  });
});
