import { describe, expect, it } from "vitest";
import {
  classifyTetoAddress,
  isCeilingReference,
  isDirectTetoAddress,
  isFeminineTetoPerson,
  mentionedJidsIncludeBot
} from "../../src/integrations/whatsapp/messageContext.js";

describe("classifyTetoAddress", () => {
  it("treats vocative + look-at-this as a call to her", () => {
    expect(classifyTetoAddress("teto olha isso")).toBe("contextual");
    expect(classifyTetoAddress("Caralho teto olha isso")).toBe("contextual");
    expect(classifyTetoAddress("caralho cade a teto")).toBe("contextual");
    expect(classifyTetoAddress("cadê a teto")).toBe("contextual");
    expect(classifyTetoAddress("cadê a teto gente")).toBe("contextual");
    expect(isDirectTetoAddress("ei teto como vai?")).toBe(true);
  });

  it("treats feminine agreement as Kasane Teto, not the ceiling", () => {
    expect(isFeminineTetoPerson("cadê a teto")).toBe(true);
    expect(classifyTetoAddress("vi a teto ontem no mercado")).toBe("contextual");
    expect(classifyTetoAddress("fala com a teto")).toBe("contextual");
    expect(classifyTetoAddress("manda pra teto")).toBe("contextual");
  });

  it("still ignores building ceiling and singer-ish masculine", () => {
    expect(isCeilingReference("o teto da sala tá vazando")).toBe(true);
    expect(classifyTetoAddress("o teto da sala tá vazando")).toBe("none");
    expect(classifyTetoAddress("atingiu o teto")).toBe("none");
    expect(classifyTetoAddress("escutar o teto no spotify")).toBe("none");
  });

  it("keeps name-only citations ambiguous", () => {
    expect(classifyTetoAddress("o bagulho do teto no youtube")).toBe("none");
    expect(classifyTetoAddress("teto e kasane no wiki são o mesmo?")).toBe("contextual");
    expect(classifyTetoAddress("bom dia galera")).toBe("none");
  });

  it("keeps WhatsApp @mention as mention", () => {
    expect(classifyTetoAddress("olha isso", { hasMention: true })).toBe("mention");
    expect(classifyTetoAddress("@Teto guarda essa figurinha")).toBe("mention");
  });

  it("matches LID mention via identity index isSelf", () => {
    const identityIndex = new Map([
      ["999888777", { displayName: "Teto", isSelf: true }]
    ]);
    expect(
      mentionedJidsIncludeBot(["999888777@lid"], {
        botJid: "6283879987068@s.whatsapp.net",
        botPhone: "6283879987068",
        botActorIds: new Set(["6283879987068", "teto"]),
        identityIndex
      })
    ).toBe(true);
  });
});
