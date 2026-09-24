import { describe, expect, it, vi } from "vitest";
import { applyUiOutgoingActions } from "../../src/integrations/automate/uiReplies.js";

function makeCtx({ enqueueImpl }) {
  const published = [];
  const uiBus = { publish: (e) => published.push(e) };
  const automateClient = { enqueue: vi.fn(enqueueImpl) };
  const thread = { id: "thread-1", messages: [], updatedAt: null };
  return { published, uiBus, automateClient, thread };
}

describe("applyUiOutgoingActions — automate", () => {
  it("publica plan.started antes de enfileirar", async () => {
    let resolveEnqueue;
    const enqueuePromise = new Promise((r) => {
      resolveEnqueue = r;
    });
    const { published, uiBus, automateClient, thread } = makeCtx({
      enqueueImpl: () => enqueuePromise,
    });

    const task = applyUiOutgoingActions({
      replies: { actions: [{ type: "automate", intent: "abrir o youtube" }] },
      thread,
      uiBus,
      automateClient,
    });

    await vi.waitFor(() => {
      expect(published.some((e) => e.type === "plan.started")).toBe(true);
    });
    expect(automateClient.enqueue).toHaveBeenCalled();
    resolveEnqueue({ content: [{ text: '{"id":"inst-1"}' }] });
    await task;

    expect(automateClient.enqueue).toHaveBeenCalledWith(
      "abrir o youtube",
      undefined,
      expect.objectContaining({ threadId: "thread-1" })
    );
    const started = published.find((e) => e.type === "plan.started");
    const failed = published.find((e) => e.type === "run.status");
    expect(failed).toBeUndefined();
    expect(started?.runId).toBeTruthy();
  });

  it("falha de enqueue usa o mesmo runId e bolha de erro", async () => {
    const { published, uiBus, automateClient, thread } = makeCtx({
      enqueueImpl: () => Promise.reject(new Error("Device offline")),
    });

    await applyUiOutgoingActions({
      replies: { actions: [{ type: "automate", intent: "abrir o youtube" }] },
      thread,
      uiBus,
      automateClient,
    });

    const started = published.find((e) => e.type === "plan.started");
    const failed = published.find((e) => e.type === "run.status" && e.status === "failed");
    expect(started).toBeTruthy();
    expect(failed?.runId).toBe(started.runId);
    expect(failed?.error).toMatch(/offline/i);
    expect(thread.messages.some((m) => m.text.includes("Device offline"))).toBe(true);
  });
});
