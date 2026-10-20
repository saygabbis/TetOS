import { describe, expect, it } from "vitest";
import { detectReminderIntent } from "../../src/modules/reminders/reminderIntent.js";
import { resolveReminderJid } from "../../src/modules/reminders/reminderDelivery.js";

// 10:00 em São Paulo
const now = new Date("2026-10-20T13:00:00Z");
const tz = "America/Sao_Paulo";
const local = (iso) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const parse = (t) => detectReminderIntent(t, { now, timeZone: tz });

describe("lembretes em português natural", () => {
  it.each([
    ["me lembra daqui 2 minutos de beber água", "20, 10:02", "beber água"],
    ["me lembra daqui a 10 min de tirar o bolo", "20, 10:10", "tirar o bolo"],
    ["me avisa em meia hora pra ligar pra mãe", "20, 10:30", "ligar pra mãe"],
    ["me lembra em 1h30 de tomar remédio", "20, 11:30", "tomar remédio"],
    ["me lembra daqui dez minutos de olhar o forno", "20, 10:10", "olhar o forno"],
    ["me lembra às 15h de buscar a encomenda", "20, 15:00", "buscar a encomenda"],
    ["me lembra 18:30 de treinar", "20, 18:30", "treinar"],
    ["me lembra amanhã às 9 de pagar a conta", "21, 09:00", "pagar a conta"],
    ["me lembra hoje à noite de lavar a louça", "20, 20:00", "lavar a louça"],
    ["lembrete: reunião às 14h", "20, 14:00", "reunião"]
  ])("%s", (text, when, what) => {
    const r = parse(text);
    expect(r?.type).toBe("create");
    expect(local(r.dueAt)).toBe(when);
    expect(r.text).toBe(what);
  });

  it("pedido sem horário não cria lembrete mudo", () => {
    expect(parse("me lembra de comprar pão")).toEqual({ type: "needs_time", text: "comprar pão" });
  });

  it.each([
    "você me lembra de memória de mim de dragão guerreiro, era piada",
    "isso me lembra minha infância",
    "me avisa quando chegar",
    "esqueci o lembrete kkk"
  ])("não é pedido de lembrete: %s", (text) => {
    expect(parse(text)).toBeNull();
  });

  it("lista lembretes", () => {
    expect(parse("quais meus lembretes?")).toEqual({ type: "list" });
  });
});

describe("entrega de lembrete", () => {
  it("vai para o chat de origem", () => {
    expect(resolveReminderJid({ chatJid: "157947506229421@lid", userId: "dm-157947506229421" })).toBe("157947506229421@lid");
    expect(resolveReminderJid({ chatJid: "120363000000000001@g.us", userId: "157947506229421" })).toBe("120363000000000001@g.us");
  });
  it("lembretes antigos: dm-<lid> → @lid, telefone → @s.whatsapp.net (antes eram descartados)", () => {
    expect(resolveReminderJid({ userId: "dm-157947506229421" })).toBe("157947506229421@lid");
    expect(resolveReminderJid({ userId: "5516988137617" })).toBe("5516988137617@s.whatsapp.net");
    expect(resolveReminderJid({ userId: "default" })).toBeNull();
  });
});
