import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  removeStickerFromRepertoire,
  saveStickerToRepertoire,
  findRepertoireEntryByMessageId
} from "../../src/integrations/whatsapp/stickerRepertoire.js";

describe("sticker repertoire remove", () => {
  it("remove by messageId deletes file and catalog entry", () => {
    const basePath = mkdtempSync(join(tmpdir(), "tetos-rep-"));
    const source = join(basePath, "src.webp");
    writeFileSync(source, "RIFF");

    const saved = saveStickerToRepertoire({
      sourcePath: source,
      basePath,
      key: "test-remove-me",
      messageId: "ACEE75CD94DB0774DB16E4151AD3A467"
    });
    expect(saved.key).toBe("test-remove-me");
    expect(existsSync(join(basePath, "test-remove-me.webp"))).toBe(true);

    const removed = removeStickerFromRepertoire({
      basePath,
      messageId: "ACEE75CD94DB0774DB16E4151AD3A467"
    });
    expect(removed.ok).toBe(true);
    expect(removed.key).toBe("test-remove-me");
    expect(existsSync(join(basePath, "test-remove-me.webp"))).toBe(false);
    expect(findRepertoireEntryByMessageId(basePath, "ACEE75CD94DB0774DB16E4151AD3A467")).toBeNull();
  });

  it("returns not_found when message is unknown", () => {
    const basePath = mkdtempSync(join(tmpdir(), "tetos-rep-"));
    const result = removeStickerFromRepertoire({
      basePath,
      messageId: "UNKNOWN123"
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_found");
  });
});
