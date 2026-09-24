import { describe, expect, it } from "vitest";
import {
  fixMisaddressedOwnerName,
  fixMisaddressedOwnerNameInReplies,
  isWhatsAppGroupIdAlias,
  sanitizeProfileNicknames,
  shouldOmitOwnerCentricMemoryHint
} from "../../src/core/channels/profileFacts.js";

describe("profileFacts", () => {
  it("detects whatsapp group id saved as alias", () => {
    expect(isWhatsAppGroupIdAlias("120363342938049353")).toBe(true);
    expect(isWhatsAppGroupIdAlias("dm-120363342938049353")).toBe(true);
    expect(isWhatsAppGroupIdAlias("190546341540031")).toBe(false);
  });

  it("drops stopword nicknames", () => {
    const cleaned = sanitizeProfileNicknames(["Kzer", "oxi", "tá", "Gabbis"], {
      displayName: "Kzer"
    });
    expect(cleaned).not.toContain("oxi");
    expect(cleaned).not.toContain("Gabbis");
  });

  it("rewrites gabbis misaddress in dm replies", () => {
    const out = fixMisaddressedOwnerName("O que foi agora, @Gabbis?", {
      isOwner: false,
      interlocutorName: "Kzer"
    });
    expect(out).toMatch(/@Kzer/i);
    expect(out).not.toMatch(/gabbis/i);
  });

  it("leaves owner dm unchanged", () => {
    const text = "Oi @Gabbis!";
    expect(
      fixMisaddressedOwnerName(text, { isOwner: true, interlocutorName: "Gabbis" })
    ).toBe(text);
  });

  it("fixes reply arrays", () => {
    const fixed = fixMisaddressedOwnerNameInReplies(
      ["Tô aqui", "E aí, Gabbis?"],
      { isOwner: false, interlocutorName: "Kzer0" }
    );
    expect(fixed[1]).toMatch(/Kzer/i);
    expect(fixed[1]).not.toMatch(/Gabbis/i);
  });

  it("preserva replies.actions ao corrigir textos", () => {
    const replies = ["ok"];
    replies.actions = [
      { type: "message", text: "Oi Gabbis" },
      { type: "automate", intent: "abrir o youtube" },
    ];
    const fixed = fixMisaddressedOwnerNameInReplies(replies, {
      isOwner: false,
      interlocutorName: "Kzer",
    });
    expect(fixed.actions).toHaveLength(2);
    expect(fixed.actions[0].text).toMatch(/Kzer/i);
    expect(fixed.actions[1]).toEqual({ type: "automate", intent: "abrir o youtube" });
  });

  it("omits owner-centric memory hints in third-party dm", () => {
    expect(
      shouldOmitOwnerCentricMemoryHint("Chama a gabbis rapidão", {
        isGroup: false,
        isOwner: false
      })
    ).toBe(true);
    expect(
      shouldOmitOwnerCentricMemoryHint("Kzer pediu ajuda com código", {
        isGroup: false,
        isOwner: false
      })
    ).toBe(false);
  });
});
