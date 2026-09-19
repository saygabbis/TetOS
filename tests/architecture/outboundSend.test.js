import { describe, expect, it, vi } from "vitest";
import {
  awaitSendOnce,
  claimOutboundDedupe,
  createOutboundMessageId,
  outboundDedupeKey,
  releaseOutboundDedupe
} from "../../src/integrations/whatsapp/outboundSend.js";

describe("outboundSend", () => {
  it("builds a stable baileys-like id", () => {
    const id = createOutboundMessageId();
    expect(id.startsWith("3EB0")).toBe(true);
    expect(id).toHaveLength(22);
    expect(createOutboundMessageId()).not.toBe(id);
  });

  it("dedupes the same jid+text inside the ttl", () => {
    const store = new Map();
    expect(claimOutboundDedupe(store, "a@lid", "oi kkk", { now: 1000 })).toBe(true);
    expect(claimOutboundDedupe(store, "a@lid", "oi kkk", { now: 5000 })).toBe(false);
    expect(claimOutboundDedupe(store, "a@lid", "outra", { now: 5000 })).toBe(true);
    releaseOutboundDedupe(store, "a@lid", "oi kkk");
    expect(claimOutboundDedupe(store, "a@lid", "OI KKK", { now: 6000 })).toBe(true);
    expect(outboundDedupeKey("a@lid", " Oi KKK ")).toBe("a@lid:oi kkk");
  });

  it("does not start a second send on timeout — waits for the original", async () => {
    let calls = 0;
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          calls += 1;
          setTimeout(() => resolve({ key: { id: "ok" } }), 40);
        })
    );
    const sent = await awaitSendOnce({
      send,
      timeoutMs: 10,
      hangWaitMs: 80
    });
    expect(calls).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toEqual({ key: { id: "ok" } });
  });

  it("does not retry after a hung send", async () => {
    const retrySend = vi.fn(async () => ({ retried: true }));
    const sent = await awaitSendOnce({
      send: () => new Promise(() => {}),
      retrySend,
      timeoutMs: 15,
      hangWaitMs: 15,
      isConnectionError: () => true
    });
    expect(sent).toBeNull();
    expect(retrySend).not.toHaveBeenCalled();
  });

  it("retries only on connection errors", async () => {
    const retrySend = vi.fn(async () => ({ key: { id: "retry" } }));
    const sent = await awaitSendOnce({
      send: async () => {
        throw new Error("Connection Closed");
      },
      retrySend,
      isConnectionError: (error) => /connection closed/i.test(error.message),
      timeoutMs: 50,
      hangWaitMs: 50
    });
    expect(retrySend).toHaveBeenCalledTimes(1);
    expect(sent).toEqual({ key: { id: "retry" } });
  });
});
