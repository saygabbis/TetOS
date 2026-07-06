import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRegistry } from "../../src/core/channels/channelRegistry.js";
import { resolvePassiveModeAction } from "../../src/core/channels/passiveModeAction.js";
import {
  isPassiveResponseMode,
  RESPONSE_MODES,
  shouldStartTypingIndicator
} from "../../src/core/pipeline/responseModes.js";

const tempDirs = [];

function tempJsonPath() {
  const dir = mkdtempSync(join(tmpdir(), "tetos-response-modes-"));
  tempDirs.push(dir);
  return join(dir, "channels.json");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("response modes", () => {
  it("knows which modes are passive outputs", () => {
    expect(isPassiveResponseMode(RESPONSE_MODES.REACT_ONLY)).toBe(true);
    expect(isPassiveResponseMode(RESPONSE_MODES.STICKER_ONLY)).toBe(true);
    expect(isPassiveResponseMode(RESPONSE_MODES.FULL)).toBe(false);
  });

  it("suppresses typing for silent and react close decisions", () => {
    expect(shouldStartTypingIndicator({ finalCloseDecision: "silent" })).toBe(false);
    expect(shouldStartTypingIndicator({ finalCloseDecision: "react" })).toBe(false);
    expect(shouldStartTypingIndicator({ finalCloseDecision: "open" })).toBe(true);
  });

  it("maps passive policies into actions", () => {
    const reactAction = resolvePassiveModeAction({
      policy: { allowed: true, mode: RESPONSE_MODES.REACT_ONLY },
      media: { type: "image" }
    });
    expect(reactAction.type).toBe(RESPONSE_MODES.REACT_ONLY);

    const blockedAction = resolvePassiveModeAction({
      policy: { allowed: false, mode: RESPONSE_MODES.FULL }
    });
    expect(blockedAction.type).toBe("ignore");
  });

  it("uses shared response mode constants in channel decisions", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const registry = new ChannelRegistry(tempJsonPath(), {
      largeGroupSize: 2
    });
    registry.upsert("group:test@g.us", {
      isGroup: true,
      participants: ["u1", "u2"],
      participantCount: 2,
      mode: "passive"
    });

    expect(
      registry.shouldRespond({ channelId: "group:test@g.us", isDirectMention: true }).mode
    ).toBe(RESPONSE_MODES.FULL);
    expect(
      registry.shouldRespond({
        channelId: "group:test@g.us",
        isDirectMention: false,
        isReply: false,
        isQuestion: false
      }).allowed
    ).toBe(false);
  });
});
