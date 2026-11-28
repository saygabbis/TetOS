import { describe, expect, it } from "vitest";
import { ChatCommandQueue } from "../../src/integrations/whatsapp/inbound/chatCommandQueue.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("ChatCommandQueue", () => {
  it("roda até 2 ao mesmo tempo e o resto espera", async () => {
    const q = new ChatCommandQueue({ perChat: 2, global: 2 });
    let live = 0;
    let peak = 0;
    const job = (v) => async () => {
      live += 1;
      peak = Math.max(peak, live);
      await wait(30);
      live -= 1;
      return v;
    };
    const out = await Promise.all([1, 2, 3, 4].map((v) => q.enqueue("a", job(v))));
    expect(out).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("um comando lento não segura os outros e erro não trava a fila", async () => {
    const q = new ChatCommandQueue({ perChat: 2, global: 2 });
    const order = [];
    const slow = q.enqueue("a", async () => {
      await wait(80);
      order.push("lento");
    });
    const bad = q.enqueue("a", async () => {
      throw new Error("x");
    }).catch(() => order.push("erro"));
    const fast = q.enqueue("b", async () => order.push("rápido"));
    await Promise.all([slow, bad, fast]);
    expect(order[order.length - 1]).toBe("lento");
    expect(order).toContain("rápido");
  });
});
