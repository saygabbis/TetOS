import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyTetoAddress,
  isLowSignalGroupMessage
} from "../../src/integrations/whatsapp/inbound/messageContext.js";
import {
  detectAgentMediaReplyIntent,
  looksLikeRepertoireStickerRequest
} from "../../src/core/media/agentMediaReplyIntent.js";
import {
  formatRepertoireForPrompt,
  formatRepertoireMatchesForPrompt,
  listRepertoireEntries,
  repertoireRotationSeed,
  searchRepertoire
} from "../../src/integrations/whatsapp/media/stickerRepertoire.js";
import { GroupEngagementWindow } from "../../src/core/channels/groupEngagementWindow.js";
import { groupJoinChance, rollGroupJoin } from "../../src/core/channels/groupJoinPolicy.js";

describe("menção no grupo", () => {
  it("marcar outra pessoa não é menção à Teto", () => {
    expect(classifyTetoAddress("@180753866477690 bora")).toBe("none");
    expect(classifyTetoAddress("olha isso", { hasMention: true })).toBe("mention");
    expect(classifyTetoAddress("@teto vem cá")).toBe("mention");
  });
});

describe("mensagens sem conteúdo no grupo", () => {
  it("risada, emoji e figurinha solta não puxam resposta pela janela", () => {
    expect(isLowSignalGroupMessage("KKKKKKKKKKKK")).toBe(true);
    expect(isLowSignalGroupMessage("kkkk mds")).toBe(true);
    expect(isLowSignalGroupMessage("Meu Deus...")).toBe(true);
    expect(isLowSignalGroupMessage("😂😂")).toBe(true);
    expect(isLowSignalGroupMessage("", { mediaType: "sticker" })).toBe(true);
  });

  it("frase de verdade, foto e áudio continuam valendo", () => {
    expect(isLowSignalGroupMessage("Vc comeria toda a comida e nada pra mim né")).toBe(false);
    expect(isLowSignalGroupMessage("", { mediaType: "image" })).toBe(false);
    expect(isLowSignalGroupMessage("", { mediaType: "audio" })).toBe(false);
  });
});

describe("pedido de figurinha pelo nome", () => {
  it("não vira conversão da mensagem citada", () => {
    expect(looksLikeRepertoireStickerRequest("manda a figurinha da aura")).toBe(true);
    expect(
      detectAgentMediaReplyIntent("manda a figurinha da aura", {
        quotedMessageId: "3EB0919C48DF04267522F6",
        isReply: true,
        quotedMessage: "minha aura já é infinita, aceita kkkk"
      })
    ).toBeNull();
  });

  it("pedir figurinha de uma imagem citada segue convertendo", () => {
    expect(
      detectAgentMediaReplyIntent("faz figurinha", {
        quotedMessageId: "3EB0AAAA",
        isReply: true,
        quotedMessage: "[image]"
      })
    ).toMatchObject({ command: "sticker", messageId: "3EB0AAAA" });
    expect(
      detectAgentMediaReplyIntent("manda figurinha da foto", {
        quotedMessageId: "3EB0AAAA",
        isReply: true,
        quotedMessage: "[image]"
      })
    ).toMatchObject({ command: "sticker", messageId: "3EB0AAAA" });
  });
});

describe("repertório de figurinhas", () => {
  function makeRepertoire() {
    const dir = mkdtempSync(join(tmpdir(), "tetos-stickers-"));
    const keys = ["teto-auruda", "gato-vermelho-sonhando-pao", "garota-anime-bebendo-xicara"];
    for (let i = 0; i < 40; i += 1) keys.push(`figurinha-aleatoria-${i}`);
    for (const k of keys) writeFileSync(join(dir, `${k}.webp`), "x");
    writeFileSync(
      join(dir, "catalog.json"),
      JSON.stringify({
        entries: [{ key: "gato-vermelho-sonhando-pao", displayName: "Gato vermelho sonhando com pão" }]
      })
    );
    return dir;
  }

  it("inclui figurinhas que só existem no disco", () => {
    const dir = makeRepertoire();
    expect(listRepertoireEntries(dir).map((e) => e.key)).toContain("teto-auruda");
  });

  it("acha a figurinha pedida pelo apelido", () => {
    const dir = makeRepertoire();
    expect(searchRepertoire(dir, "manda a figurinha da aura")[0]?.key).toBe("teto-auruda");
    expect(searchRepertoire(dir, "manda aquela do gato")[0]?.key).toBe("gato-vermelho-sonhando-pao");
  });

  it("o bloco do turno traz a figurinha que combina com o pedido", () => {
    const dir = makeRepertoire();
    expect(formatRepertoireMatchesForPrompt(dir, "manda a figurinha da aura").join(" ")).toContain("teto-auruda");
    expect(formatRepertoireMatchesForPrompt(dir, "kkkk")).toEqual([]);
  });

  it("a lista fixa é estável no mesmo período e gira entre períodos", () => {
    const dir = makeRepertoire();
    const seed = repertoireRotationSeed(0);
    expect(formatRepertoireForPrompt(dir, 10, { seed })).toBe(formatRepertoireForPrompt(dir, 10, { seed }));
    expect(repertoireRotationSeed(3600_000)).toBe(seed);
    expect(formatRepertoireForPrompt(dir, 10, { seed: repertoireRotationSeed(7 * 3600_000) })).not.toBe(
      formatRepertoireForPrompt(dir, 10, { seed })
    );
  });
});

describe("entrar no papo do grupo (decisão dinâmica)", () => {
  it("na conversa com ela tende a seguir; risada solta raramente puxa resposta", () => {
    expect(groupJoinChance({ inWindow: true }).chance).toBeGreaterThan(0.7);
    expect(groupJoinChance({ inWindow: true, lowSignal: true }).chance).toBeLessThan(0.25);
    expect(groupJoinChance({ inWindow: true, lowSignal: true }).chance).toBeGreaterThan(0);
  });

  it("cansa: quanto mais falou agora há pouco, menor a vontade", () => {
    const fresh = groupJoinChance({ inWindow: true }).chance;
    const tired = groupJoinChance({ inWindow: true, recentBotTurns: 3, msSinceBotTurn: 5_000 }).chance;
    expect(tired).toBeLessThan(fresh / 4);
  });

  it("papo dos outros: pode se meter, mas só com conversa rolando e sabendo que não era com ela", () => {
    expect(groupJoinChance({ addressedToSomeoneElse: true, liveMessages: 1 }).mode).toBeNull();
    const live = groupJoinChance({ addressedToSomeoneElse: true, liveMessages: 8 });
    expect(live.mode).toBe("bystander");
    expect(live.chance).toBeGreaterThan(0);
    expect(live.chance).toBeLessThan(0.3);
    expect(rollGroupJoin({ addressedToSomeoneElse: true, liveMessages: 8 }, () => 0).mode).toBe("bystander");
    expect(rollGroupJoin({ addressedToSomeoneElse: true, liveMessages: 8 }, () => 0.99).mode).toBeNull();
  });

  it("o ritmo do grupo conta mensagens vivas e falas recentes dela", () => {
    const w = new GroupEngagementWindow();
    for (let i = 0; i < 4; i += 1) w.noteGroupMessage("g1@g.us", i * 1000);
    w.noteBotTurn("g1@g.us", 3000);
    expect(w.groupPulse("g1@g.us", 4000)).toEqual({ recentBotTurns: 1, msSinceBotTurn: 1000, liveMessages: 4 });
    expect(w.groupPulse("g1@g.us", 10 * 60_000)).toEqual({ recentBotTurns: 0, msSinceBotTurn: Infinity, liveMessages: 0 });
  });

  it("calar o canal vale pra todo mundo do grupo", () => {
    const w = new GroupEngagementWindow();
    w.muteFromAgent("g1@g.us", "dona", { scope: "canal", ttlMs: 60_000, now: 0 });
    expect(w.isMuted("g1@g.us", "outra-pessoa", 1000)).toBe(true);
    expect(w.isMuted("g1@g.us", null, 1000)).toBe(true);
    expect(w.isMuted("g1@g.us", "outra-pessoa", 61_000)).toBe(false);
  });
});
