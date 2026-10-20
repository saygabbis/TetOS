import { describe, expect, it } from "vitest";
import { prepareSpokenText, VoiceNotes } from "../../src/modules/voice/voiceNotes.js";

describe("áudio de voz", () => {
  it("fala o texto sem emoji, link, @ e com risada falada", () => {
    expect(prepareSpokenText("oiee @Gabbis!!! 😍 olha https://x.com/a kkkkk")).toBe("oiee Gabbis! olha ha ha");
  });
  it("áudio espontâneo tem intervalo; pedido libera", () => {
    let now = 0;
    const v = new VoiceNotes({ enabled: true, now: () => now });
    expect(v.canSend("chat")).toBe(true);
    v.markSent("chat");
    now = 60_000;
    expect(v.canSend("chat")).toBe(false);
    expect(v.canSend("chat", { requested: true })).toBe(true);
  });
});
