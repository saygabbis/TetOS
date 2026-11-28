import { describe, expect, it } from "vitest";
import { DeferredInbox } from "../../src/integrations/whatsapp/conversation/deferredInbox.js";

describe("caixa de mensagens guardadas — quem falou", () => {
  it("leva com várias pessoas não vira fala da última (nem da dona)", () => {
    const inbox = new DeferredInbox(null);
    inbox.append("discord-ch:1", { userId: "discord:gabbis", speakerName: "Gabbrielly", message: "oi teto", isOwner: true });
    inbox.append("discord-ch:1", { userId: "discord:martin", speakerName: "Martin", message: "cala a boca bot" });
    const caught = inbox.flush("discord-ch:1");
    expect(caught.message).toContain("[Gabbrielly]: oi teto");
    expect(caught.message).toContain("[Martin]: cala a boca bot");
    expect(caught.message).not.toMatch(/discord:/);
    expect(caught.multiSpeaker).toBe(true);
    expect(caught.isOwner).toBe(false);
    expect(caught.segmentParts.map((p) => p.speakerName)).toEqual(["Gabbrielly", "Martin"]);
  });

  it("uma pessoa só continua igual", () => {
    const inbox = new DeferredInbox(null);
    inbox.append("wa", { userId: "u1", pushName: "Ana", message: "a", isOwner: true });
    inbox.append("wa", { userId: "u1", pushName: "Ana", message: "b", isOwner: true });
    const caught = inbox.flush("wa");
    expect(caught.message).toBe("a\nb");
    expect(caught.multiSpeaker).toBeUndefined();
    expect(caught.isOwner).toBe(true);
  });
});
