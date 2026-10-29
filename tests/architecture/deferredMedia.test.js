import { describe, expect, it } from "vitest";
import { DeferredInbox } from "../../src/integrations/whatsapp/conversation/deferredInbox.js";
import { formatMediaInputText } from "../../src/core/channels/mediaTimelineEnrich.js";
import { applyVisionFields } from "../../src/integrations/whatsapp/inbound/waHandlerUtils.js";

describe("figurinha guardada enquanto ela estava ocupada", () => {
  it("a promessa da visão não vai pro disco (virava {} e depois '[object Object]')", () => {
    const inbox = new DeferredInbox(null);
    const visionPromise = new Promise(() => {});
    inbox.append("s1", { message: "[sticker]", media: { type: "sticker", path: "x.webp", visionPromise }, mediaVisionPromise: visionPromise, messageKey: { id: "M1" } });
    const entry = inbox.flush("s1");
    expect(entry.media.visionPromise).toBeUndefined();
    expect(entry.mediaVisionPromise).toBeUndefined();
    expect(formatMediaInputText({ text: "", media: entry.media })).toBe("[sticker]");
  });

  it("a descrição que chega depois entra na mensagem guardada", () => {
    const inbox = new DeferredInbox(null);
    inbox.append("s1", { message: "[sticker]", media: { type: "sticker" }, messageKey: { id: "M2" } });
    expect(inbox.updateMedia("M2", "Sticker: personagem fofa cobrindo a boca")).toBe(true);
    const entry = inbox.flush("s1");
    expect(entry.message).toBe("Sticker: personagem fofa cobrindo a boca");
    expect(entry.media.transcript).toMatch(/fofa/);
    expect(inbox.updateMedia("nao-existe", "x")).toBe(false);
  });

  it("objeto no lugar de texto nunca vira '[object Object]'", () => {
    expect(formatMediaInputText({ text: "", media: { type: "sticker", transcript: {} } })).toBe("[sticker]");
    expect(applyVisionFields({ type: "sticker", path: "x" }, {}).transcript).toBeNull();
    expect(applyVisionFields({ type: "sticker", path: "x" }, "uma figurinha").transcript).toBe("uma figurinha");
  });
});
