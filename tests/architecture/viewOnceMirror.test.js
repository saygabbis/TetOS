import { describe, expect, it } from "vitest";
import {
  extractViewOnceInner,
  isViewOnceMessage,
  isViewOnceStub,
  viewOnceMediaKind
} from "../../src/integrations/whatsapp/viewOnceDetect.js";
import { ViewOnceMirrorStore } from "../../src/integrations/whatsapp/viewOnceMirrorStore.js";
import { ViewOnceMirrorService } from "../../src/integrations/whatsapp/viewOnceMirrorService.js";

describe("view once detect", () => {
  it("detects viewOnceMessageV2 wrapper", () => {
    const raw = {
      viewOnceMessageV2: {
        message: { imageMessage: { mimetype: "image/jpeg", viewOnce: true } }
      }
    };
    expect(isViewOnceMessage(raw, { isViewOnce: true })).toBe(true);
    expect(viewOnceMediaKind(extractViewOnceInner(raw))).toBe("image");
  });

  it("detects stub absent from node", () => {
    expect(
      isViewOnceStub({
        messageStubType: 2,
        messageStubParameters: ["Message absent from node"],
        key: { isViewOnce: true }
      })
    ).toBe(true);
  });
});

describe("view once mirror store", () => {
  it("toggles enabled state", () => {
    const store = new ViewOnceMirrorStore("./data/test-viewOnceMirror-toggle.json");
    store.disable();
    expect(store.isEnabled()).toBe(false);
    store.enable("admin");
    expect(store.isEnabled()).toBe(true);
    store.disable();
    expect(store.isEnabled()).toBe(false);
  });
});

describe("view once mirror admin gate", () => {
  it("blocks non-admin command", () => {
    const store = new ViewOnceMirrorStore("./data/test-viewOnceMirror-admin.json");
    store.disable();
    const runtime = {
      defaults: { learningTargetUserId: "5516988137617", adminUserId: "5516988137617" },
      operationRouter: { isAdmin: (uid) => uid === "5516988137617" }
    };
    const svc = new ViewOnceMirrorService({ store, runtime });
    const blocked = svc.handleCommand({ userId: "999", remoteJid: "999@s.whatsapp.net" });
    expect(blocked.forbidden).toBe(true);
    const ok = svc.handleCommand({
      userId: "5516988137617",
      remoteJid: "5516988137617@s.whatsapp.net",
      args: ["on"]
    });
    expect(ok.reply).toMatch(/ATIVA/i);
    expect(store.isEnabled()).toBe(true);
  });
});
