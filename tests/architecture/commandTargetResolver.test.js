import { describe, expect, it, vi } from "vitest";
import { resolveCommandTarget } from "../../src/integrations/whatsapp/commandTargetResolver.js";

function historyStore(latest = null) {
  return { latest: () => latest };
}

describe("resolveCommandTarget", () => {
  it("uses media already persisted on the same captioned attachment", async () => {
    const persistMedia = vi.fn();
    const resolved = await resolveCommandTarget({
      incoming: {
        key: { id: "CAP1" },
        message: { imageMessage: { caption: ".sticker" } }
      },
      remoteJid: "x@s.whatsapp.net",
      media: { type: "image", path: "/tmp/CAP1-image.jpg", caption: ".sticker" },
      historyStore: historyStore(),
      persistMedia,
      downloadContentFromMessage: vi.fn(),
      basePath: "./data/media-missing-for-tests"
    });
    expect(resolved).toMatchObject({
      source: "self",
      media: { type: "image", path: "/tmp/CAP1-image.jpg" }
    });
    expect(persistMedia).not.toHaveBeenCalled();
  });

  it("downloads the same-message attachment when command is in the caption", async () => {
    const persistMedia = vi.fn(async ({ id, content }) => {
      expect(content).toMatchObject({ caption: ".sticker" });
      return `/tmp/${id}.jpg`;
    });
    const resolved = await resolveCommandTarget({
      incoming: {
        key: { id: "CAP2" },
        message: {
          imageMessage: { caption: ".sticker", mimetype: "image/jpeg" }
        }
      },
      remoteJid: "x@s.whatsapp.net",
      media: null,
      historyStore: historyStore(),
      persistMedia,
      downloadContentFromMessage: vi.fn(),
      basePath: "./data/media-missing-for-tests"
    });
    expect(resolved.source).toBe("self");
    expect(resolved.media.type).toBe("image");
    expect(resolved.media.path).toBe("/tmp/CAP2-image.jpg");
    expect(persistMedia).toHaveBeenCalledTimes(1);
  });

  it("still resolves media quoted by reply when the command has no attachment", async () => {
    const persistMedia = vi.fn(async ({ id }) => `/tmp/${id}.jpg`);
    const resolved = await resolveCommandTarget({
      incoming: {
        key: { id: "CMD1" },
        message: {
          extendedTextMessage: {
            text: ".sticker",
            contextInfo: {
              quotedMessage: {
                imageMessage: { mimetype: "image/jpeg" }
              }
            }
          }
        }
      },
      remoteJid: "x@s.whatsapp.net",
      media: null,
      historyStore: historyStore(),
      persistMedia,
      downloadContentFromMessage: vi.fn(),
      basePath: "./data/media-missing-for-tests"
    });
    expect(resolved.source).toBe("reply");
    expect(resolved.media.type).toBe("image");
    expect(resolved.media.path).toContain("quoted");
  });

  it("prefers the captioned attachment over a quoted message", async () => {
    const persistMedia = vi.fn(async ({ id, content }) => {
      if (content?.mimetype === "image/png") return `/tmp/${id}.png`;
      return `/tmp/${id}.jpg`;
    });
    const resolved = await resolveCommandTarget({
      incoming: {
        key: { id: "CAP3" },
        message: {
          imageMessage: {
            caption: ".toimg",
            mimetype: "image/png",
            contextInfo: {
              quotedMessage: {
                stickerMessage: { isAnimated: false }
              }
            }
          }
        }
      },
      remoteJid: "x@s.whatsapp.net",
      media: null,
      historyStore: historyStore(),
      persistMedia,
      downloadContentFromMessage: vi.fn(),
      basePath: "./data/media-missing-for-tests"
    });
    expect(resolved.source).toBe("self");
    expect(resolved.media.type).toBe("image");
    expect(resolved.media.path).toContain("CAP3-image");
  });

  it("does not reuse the last chat media when there is no attachment or reply", async () => {
    const persistMedia = vi.fn();
    const resolved = await resolveCommandTarget({
      incoming: {
        key: { id: "BARE1" },
        message: { conversation: ".sticker" }
      },
      remoteJid: "x@s.whatsapp.net",
      userId: "u1",
      media: null,
      historyStore: historyStore({
        media: { type: "image", path: "/tmp/last-photo.jpg" }
      }),
      persistMedia,
      downloadContentFromMessage: vi.fn(),
      basePath: "./data/media-missing-for-tests"
    });
    expect(resolved).toEqual({ source: "none", media: null });
    expect(persistMedia).not.toHaveBeenCalled();
  });
});
