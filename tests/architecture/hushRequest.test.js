import { describe, expect, it } from "vitest";
import { detectHushRequest } from "../../src/core/channels/hushRequest.js";

describe("pedido de silêncio", () => {
  it.each(["teto fica quieta um minutinho, tô numa call", "para de falar um pouco", "cala a boca kkk", "shhh", "silêncio teto", "tô em reunião, depois falo"])("%s", (t) => {
    expect(detectHushRequest(t)).toBe(true);
  });
  it.each(["não precisa ficar quieta não", "tô numa call com minha mãe kkk", "que silêncio nesse grupo hein", "oi teto"])("não é pedido: %s", (t) => {
    expect(detectHushRequest(t)).toBe(false);
  });
});
