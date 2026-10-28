import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityLinkStore, parseLinkCommand, resolveDiscordUserId } from "../../src/core/identity/identityLinks.js";
import { AttentionFocus } from "../../src/core/presence/attentionFocus.js";
import { buildPlatformBlock, markdownRuleLine } from "../../src/core/agent/platformPrompt.js";
import { reminderChatId } from "../../src/core/pipeline/messagePipeline.js";
import { isDiscordReminder, deliverDueReminders } from "../../src/modules/reminders/reminderDelivery.js";
import { applyOutgoingMentions, readableContent, splitForDiscord } from "../../src/integrations/discord/discordText.js";
import { isNameCall } from "../../src/integrations/discord/discordConversation.js";
import { mediaTypeOf } from "../../src/integrations/discord/discordMedia.js";
import { buildCommandDefinitions } from "../../src/integrations/discord/discordCommands.js";

describe("vínculo Discord ↔ WhatsApp", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "links-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("código do Discord, mandado no zap, liga a conta ao userId do PV", () => {
    let now = 1_000_000;
    const store = new IdentityLinkStore(join(dir, "links.json"), { now: () => now });
    const { code } = store.createCode({ discordId: "42", discordName: "gab" });
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(resolveDiscordUserId(store, "42").userId).toBe("discord:42");
    const linked = store.redeem(code.toLowerCase(), { userId: "dm-123", name: "Gabbis" });
    expect(linked).toMatchObject({ discordId: "42", userId: "dm-123" });
    expect(resolveDiscordUserId(store, "42")).toEqual({ userId: "dm-123", linked: true });
    expect(store.discordIdsFor("dm-123")).toEqual(["42"]);
    expect(store.redeem(code, { userId: "dm-999" })).toBeNull();
  });

  it("código vence em 10 min e pedir outro invalida o anterior", () => {
    let now = 0;
    const store = new IdentityLinkStore(join(dir, "links.json"), { now: () => now });
    const first = store.createCode({ discordId: "1" }).code;
    const second = store.createCode({ discordId: "1" }).code;
    expect(store.redeem(first, { userId: "dm-1" })).toBeNull();
    now += 11 * 60_000;
    expect(store.redeem(second, { userId: "dm-1" })).toBeNull();
  });

  it("dona sem vínculo cai na identidade dela do zap", () => {
    const store = new IdentityLinkStore(null);
    expect(resolveDiscordUserId(store, "7", { isOwner: true, ownerFallbackUserId: "dm-dona" })).toEqual({ userId: "dm-dona", linked: true });
  });

  it("comando no zap: .vincular CÓDIGO, /vincular, e não pega frase solta", () => {
    expect(parseLinkCommand(".vincular ab12cd")).toEqual({ action: "link", code: "AB12CD" });
    expect(parseLinkCommand("/vincular AB12CD")).toEqual({ action: "link", code: "AB12CD" });
    expect(parseLinkCommand("vincular AB12CD")).toEqual({ action: "link", code: "AB12CD" });
    expect(parseLinkCommand(".desvincular")).toEqual({ action: "unlink", code: null });
    expect(parseLinkCommand("vincular")).toBeNull();
    expect(parseLinkCommand("quero vincular minha conta")).toBeNull();
  });
});

describe("atenção: uma conversa por vez entre os apps", () => {
  it("no meio de um papo no Discord, o zap espera uns segundos (e vice-versa)", () => {
    let now = 0;
    const att = new AttentionFocus({ now: () => now, random: () => 0.5 });
    expect(att.switchDelayMs("whatsapp")).toBe(0);
    att.note("discord", "discord:1", "#geral no servidor X");
    expect(att.switchDelayMs("discord")).toBe(0);
    const d = att.switchDelayMs("whatsapp");
    expect(d).toBeGreaterThanOrEqual(15_000);
    expect(d).toBeLessThanOrEqual(45_000);
    expect(att.switchDelayMs("whatsapp", { isOwner: true })).toBeLessThan(d);
    expect(att.promptLine("whatsapp")).toMatch(/Discord \(#geral no servidor X\)/);
    now += 4 * 60_000;
    expect(att.switchDelayMs("whatsapp")).toBe(0);
  });
});

describe("prompt sabe onde está", () => {
  it("Discord: diz que é Discord, libera markdown leve; zap menciona o Discord", () => {
    const d = buildPlatformBlock({ platform: "discord", platformPlace: "#geral no servidor X", isGroup: true }).join("\n");
    expect(d).toMatch(/DISCORD — #geral/);
    expect(d).toMatch(/pessoal de verdade .* WhatsApp/);
    expect(markdownRuleLine({ platform: "discord" })).not.toMatch(/ZERO markdown/);
    expect(markdownRuleLine({ platform: "whatsapp" })).toMatch(/ZERO markdown/);
    expect(buildPlatformBlock({ platform: "whatsapp", discordAvailable: true }).join("\n")).toMatch(/conta no Discord/);
    expect(buildPlatformBlock({ platform: "whatsapp" })).toEqual([]);
    expect(buildPlatformBlock({ platform: "whatsapp", attentionLine: "veio do discord" })).toEqual(["[TROCOU DE APP]", "veio do discord"]);
  });
});

describe("lembretes por app", () => {
  it("pedido no Discord fica com o canal e é entregue pelo Discord", async () => {
    expect(reminderChatId("discord:123")).toBe("discord:123");
    expect(reminderChatId("5511@s.whatsapp.net")).toBe("5511@s.whatsapp.net");
    expect(reminderChatId("direct:abc")).toBeNull();
    const rows = [
      { id: "a", userId: "dm-1", chatJid: "discord:555", text: "beber água" },
      { id: "b", userId: "dm-1", chatJid: "5511@s.whatsapp.net", text: "dormir" }
    ];
    expect(rows.filter(isDiscordReminder).map((r) => r.id)).toEqual(["a"]);
    const delivered = [];
    const runtime = {
      reminderScheduler: { pendingDelivery: () => rows, markDeliverySweep: () => {} },
      reminders: { markDeliveryAttempt: () => {}, markDelivered: (id) => delivered.push(id) }
    };
    const sent = [];
    await deliverDueReminders(runtime, null, { platform: "discord", send: async (ch, text) => sent.push([ch, text]) });
    expect(sent).toEqual([["555", "⏰ ei, lembrete: beber água"]]);
    const wa = [];
    await deliverDueReminders(runtime, { sendMessage: async (jid) => wa.push(jid) });
    expect(wa).toEqual(["5511@s.whatsapp.net"]);
    expect(delivered).toEqual(["a", "b"]);
  });
});

describe("texto no Discord", () => {
  const fakeMessage = (content) => ({
    content,
    mentions: { members: new Map([["9", { displayName: "Gabbis" }]]), users: new Map() },
    guild: { channels: { cache: new Map([["5", { name: "geral" }]]) }, roles: { cache: new Map() } }
  });

  it("menções e emojis viram texto; marcação dela no começo some", () => {
    expect(readableContent(fakeMessage("<@111> oi <@9>, vem no <#5> <:kek:123>"), { botId: "111" })).toBe("oi @Gabbis, vem no #geral :kek:");
  });

  it("@nome que ela escreve vira menção só de quem está no papo, nunca @everyone", () => {
    const people = [{ id: "9", names: ["Gabbis", "saygabbis"] }, { id: "8", names: ["Kzer0"] }];
    expect(applyOutgoingMentions("oi @gabbis e @kzer!", people)).toEqual({ text: "oi <@9> e <@8>!", userIds: ["9", "8"] });
    expect(applyOutgoingMentions("@everyone olha", people).text).toBe("@everyone olha");
    expect(applyOutgoingMentions("email a@b.com", people).text).toBe("email a@b.com");
  });

  it("quebra texto grande no limite do Discord", () => {
    const parts = splitForDiscord("palavra ".repeat(600), 1900);
    expect(parts.length).toBe(3);
    expect(parts.every((p) => p.length <= 1900)).toBe(true);
  });

  it("chamar pelo nome conta como chamar ela", () => {
    expect(isNameCall("teto, o que acha?")).toBe(true);
    expect(isNameCall("oi teto")).toBe(true);
    expect(isNameCall("né teto?")).toBe(true);
    expect(isNameCall("o teto da sala tá pingando")).toBe(false);
    expect(isNameCall("bora jogar")).toBe(false);
  });

  it("tipo de anexo no vocabulário do zap", () => {
    expect(mediaTypeOf({ contentType: "image/gif" })).toBe("gif");
    expect(mediaTypeOf({ contentType: "image/png" })).toBe("image");
    expect(mediaTypeOf({ name: "x.mp4" })).toBe("video");
    expect(mediaTypeOf({ contentType: "audio/ogg" })).toBe("audio");
  });

  it("comandos / são válidos pro Discord", () => {
    const defs = buildCommandDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["teto", "vincular", "figurinha", "baixar", "Fazer figurinha"]));
    expect(new Set(names).size).toBe(names.length);
  });
});
