import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseUrlDownloadArgs, parseTimeToken } from "../../src/integrations/whatsapp/commands/urlDownloadArgsParse.js";
import { isUrlMediaCommand, toUrlCommand } from "../../src/integrations/whatsapp/commands/mediaCommandParser.js";
import { parseCompressTarget, parseMediaEditArgs } from "../../src/core/media/mediaEditCommands.js";
import { STYLES, runLinkCommand } from "../../src/core/media/linkCommandRunner.js";
import { softenModeratorTone } from "../../src/modules/chat/chatService.js";
import { RelationshipCommitmentStore } from "../../src/core/social/RelationshipCommitmentStore.js";
import { resolveCommand } from "../../src/integrations/whatsapp/commands/commandCatalog.js";
import {
  discordHelpMessages,
  resolveDiscordAgentCommand,
  runDiscordCommand,
  toDiscordMarkdown
} from "../../src/integrations/discord/discordCommandRunner.js";
import { slashToCommand } from "../../src/integrations/discord/discordCommands.js";

const YT = "https://youtu.be/abc123";

describe("parser dos comandos de link (Convenus)", () => {
  it("trecho, qualidade, legenda gravada e tamanho em qualquer ordem", () => {
    const p = parseUrlDownloadArgs("youtube", [YT, "1080", "1:20", "1:45", "leg:pt", "8mb", "mp4"]);
    expect(p).toMatchObject({ mode: "mp4", quality: "1080", embedSubs: "pt", clip: { start: 80, end: 105 }, maxMb: 8, error: null });
  });

  it("formatos de tempo", () => {
    expect(parseTimeToken("1:20")).toBe(80);
    expect(parseTimeToken("90s")).toBe(90);
    expect(parseTimeToken("1m30s")).toBe(90);
  });

  it(".cortar exige trecho e fim depois do começo", () => {
    expect(parseUrlDownloadArgs("cortar", [YT]).error).toMatch(/trecho/);
    expect(parseUrlDownloadArgs("cortar", [YT, "2:00", "1:00"]).error).toBeTruthy();
    expect(parseUrlDownloadArgs("cortar", [YT, "1:00-1:30", "mp3"])).toMatchObject({ mode: "mp3", clip: { start: 60, end: 90 } });
  });

  it(".gif tem padrão e limite de 60s", () => {
    const g = parseUrlDownloadArgs("gif", [YT]);
    expect(g.gif).toEqual({ fps: 15, width: 480 });
    expect(g.clip).toBeTruthy();
    expect(parseUrlDownloadArgs("gif", [YT, "0:00", "2:00"]).error).toMatch(/60/);
  });

  it(".playlist escolhe faixas", () => {
    expect(parseUrlDownloadArgs("playlist", [YT, "1-3"]).selection).toEqual({ all: false, indexes: [0, 1, 2] });
    expect(parseUrlDownloadArgs("playlist", [YT, "2,5"]).selection.indexes).toEqual([1, 4]);
    expect(parseUrlDownloadArgs("playlist", [YT, "todas"]).selection.all).toBe(true);
    expect(parseUrlDownloadArgs("playlist", [YT]).selection).toEqual({ all: false, indexes: null });
  });

  it(".perfil: resumo, foto, capa, seção e quantidade", () => {
    expect(parseUrlDownloadArgs("perfil", [YT]).profile.action).toBe("info");
    expect(parseUrlDownloadArgs("perfil", [YT, "info"]).profile.action).toBe("info");
    expect(parseUrlDownloadArgs("perfil", [YT, "foto"]).profile.action).toBe("avatar");
    expect(parseUrlDownloadArgs("perfil", [YT, "capa"]).profile.action).toBe("banner");
    expect(parseUrlDownloadArgs("perfil", [YT, "shorts", "30"]).profile).toEqual({ action: "section", section: "shorts", count: 10 });
  });
});

describe("comandos híbridos (link ou mídia do chat)", () => {
  it("só vira comando de link quando tem link", () => {
    expect(isUrlMediaCommand("cortar", ["0:10", "0:20"])).toBe(false);
    expect(isUrlMediaCommand("cortar", [YT, "0:10", "0:20"])).toBe(true);
    expect(isUrlMediaCommand("youtube")).toBe(true);
  });

  it(".comprimir com link baixa já comprimido", () => {
    expect(toUrlCommand({ command: "comprimir", args: [YT, "5"] })).toEqual({ command: "download", args: [YT, "5mb"] });
    expect(toUrlCommand({ command: "comprimir", args: [YT] }).args).toContain("8mb");
  });

  it("tamanho alvo e trecho de mídia do chat", () => {
    expect(parseCompressTarget(["8"])).toBe(8);
    expect(parseCompressTarget(["8,5mb"])).toBe(8.5);
    expect(parseCompressTarget(["512kb"])).toBe(0.5);
    expect(parseCompressTarget([], 9)).toBe(9);
    expect(parseMediaEditArgs(["0:10", "0:30", "mp3"])).toMatchObject({ clip: { start: 10, end: 30 }, toAudio: true });
    expect(parseMediaEditArgs([]).clip).toBeNull();
  });
});

describe("runLinkCommand", () => {
  const playlistInfo = {
    type: "video",
    playlist: true,
    title: "Álbum",
    items: [{ label: "Faixa 1" }, { label: "Faixa 2" }, { label: "Faixa 3" }]
  };
  const convenus = (extra = {}) => ({ isConfigured: () => true, info: vi.fn(async () => playlistInfo), ...extra });

  it("playlist sem escolha só lista", async () => {
    const parsed = parseUrlDownloadArgs("playlist", [YT]);
    const r = await runLinkCommand(parsed, { downloader: {}, convenus: convenus(), style: STYLES.discord });
    expect(r.text).toMatch(/Faixa 1/);
    expect(r.text).toMatch(/\*\*Álbum\*\*/);
  });

  it("playlist com escolha baixa e avisa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-"));
    const f = join(dir, "a.mp3");
    writeFileSync(f, "x");
    const downloadPlaylist = vi.fn(async () => ({ title: "Álbum", files: [{ path: f, label: "Faixa 2" }], failed: [] }));
    const downloader = { _fromConvenus: vi.fn(async () => ({ outputs: [{ path: f, kind: "audio", label: "Faixa 2" }] })) };
    const notify = vi.fn(async () => {});
    const r = await runLinkCommand(parseUrlDownloadArgs("playlist", [YT, "2"]), { downloader, convenus: convenus({ downloadPlaylist }), notify });
    expect(downloadPlaylist).toHaveBeenCalledWith(YT, expect.objectContaining({ indexes: [1], kind: "mp3" }));
    expect(notify).toHaveBeenCalled();
    expect(r.outputs).toHaveLength(1);
    expect(r.captionPerItem).toBe(true);
  });
});

describe("tom de moderadora vira zoeira", () => {
  it("troca o sermão e deixa o resto", () => {
    const out = softenModeratorTone([
      { type: "message", text: "vou me cuidar, mas não vou entrar nessa insinuação sexual. já chega desse assunto" },
      { type: "message", text: "e aí, comeu?" }
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).not.toMatch(/insinua|chega/);
    expect(out[1].text).toBe("e aí, comeu?");
  });
});

describe("flerte com a dona", () => {
  const store = () => {
    const s = new RelationshipCommitmentStore(join(mkdtempSync(join(tmpdir(), "rel-")), "r.json"));
    s.data.commitment = { status: "dating", partnerUserId: "discord:1", partnerDisplayName: "X", milestones: [], relationshipNotes: [] };
    return s;
  };

  it("a dona nunca é terceira: ganha o bloco de flerte recíproco", () => {
    const t = store().processTurn({ message: "se tu n se cuida eu saboreio o ce", userId: "dm-dona", isOwner: true });
    expect(t.flirtFromNonPartner).toBe(false);
    expect(t.promptContext.lines.join(" ")).toMatch(/dá bola/);
  });

  it("outra pessoa continua sendo recusada", () => {
    const t = store().processTurn({ message: "casa comigo teto, te amo", userId: "dm-outro" });
    expect(t.promptContext.lines[0]).toBe("[RELACIONAMENTO — COMPROMETIDA]");
  });
});

describe("Discord: comandos pelo catálogo", () => {
  const fakeOpt = (values) => ({
    getString: (k) => values[k] ?? null,
    getNumber: (k) => (typeof values[k] === "number" ? values[k] : null),
    getInteger: (k) => (typeof values[k] === "number" ? values[k] : null)
  });

  it("slash vira o comando de ponto equivalente", () => {
    expect(slashToCommand("baixar", fakeOpt({ link: YT, formato: "mp3", inicio: "1:00", fim: "1:30", tamanho: 9 }))).toEqual({
      command: "youtube",
      args: [YT, "mp3", "1:00", "1:30", "9mb"]
    });
    expect(slashToCommand("baixar", fakeOpt({ link: YT, formato: "gif" })).command).toBe("gif");
    expect(slashToCommand("cortar", fakeOpt({ inicio: "0:10", fim: "0:20" }))).toEqual({ command: "cortar", args: ["0:10", "0:20"] });
    expect(slashToCommand("perfil", fakeOpt({ link: YT, pegar: "info" })).args).toEqual([YT]);
    expect(slashToCommand("playlist", fakeOpt({ link: YT, itens: "1-3" })).args).toEqual([YT, "1-3"]);
  });

  it("markdown do zap vira do Discord", () => {
    expect(toDiscordMarkdown("✅ *pronto* _ok_")).toBe("✅ **pronto** _ok_");
  });

  it("help cabe nos limites do Discord", () => {
    for (const msg of discordHelpMessages([], ".")) {
      expect(msg.embeds.length).toBeLessThanOrEqual(10);
      const total = msg.embeds.reduce((a, e) => a + (e.title?.length ?? 0) + e.description.length, 0);
      expect(total).toBeLessThanOrEqual(6000);
    }
    const all = discordHelpMessages([], ".").flatMap((m) => m.embeds.map((e) => e.description)).join("\n");
    expect(all).toMatch(/\.cortar/);
    expect(all).not.toMatch(/teto-ativar/);
  });

  const io = (overrides = {}) => {
    const sent = [];
    return {
      sent,
      io: { author: { id: "u1" }, channel: { id: "c1", sendTyping: async () => {} }, isDM: false, send: async (p) => sent.push(p), findMedia: async () => null, ...overrides }
    };
  };
  const ctx = (media = { run: vi.fn() }) => ({ runtime: { defaults: { commandPrefix: "." } }, media, isOwnerId: () => false, identityOf: () => ({ userId: "discord:u1" }) });

  it("comando do zap aponta pro equivalente daqui", async () => {
    const { sent, io: x } = io();
    const out = await runDiscordCommand(resolveCommand(".vincular", "."), ctx(), x);
    expect(out.ok).toBe(false);
    expect(sent[0].content).toMatch(/\/vincular/);
  });

  it("comando geral responde com negrito do Discord", async () => {
    const { sent, io: x } = io();
    await runDiscordCommand(resolveCommand(".moeda", "."), ctx(), x);
    expect(sent[0].content).toMatch(/\*\*(cara|coroa)\*\*/);
  });

  it("comando de mídia sem mídia pede o arquivo", async () => {
    const media = { run: vi.fn() };
    const { sent, io: x } = io();
    const out = await runDiscordCommand(resolveCommand(".cortar 0:10 0:20", "."), ctx(media), x);
    expect(out.reason).toBe("no_media");
    expect(media.run).not.toHaveBeenCalled();
    expect(sent[0].content).toMatch(/mídia/);
  });

  it("link roda o motor e manda arquivo com legenda", async () => {
    const media = { run: vi.fn(async () => ({ files: [{ path: "/tmp/x.mp3", name: "x.mp3" }], text: "✅ pronto" })) };
    const { sent, io: x } = io();
    await runDiscordCommand(resolveCommand(`.mp3 ${YT}`, "."), ctx(media), x);
    expect(media.run).toHaveBeenCalledWith("mp3", [YT], expect.objectContaining({ input: null }));
    expect(sent[0]).toMatchObject({ content: "✅ pronto", files: [{ name: "x.mp3" }] });
  });

  it(".tetos digitado fica com a conversa; a IA lê comando com ou sem ponto", async () => {
    const { io: x } = io();
    expect((await runDiscordCommand(resolveCommand(".tetos oi", "."), ctx(), x)).handled).toBe(false);
    expect(resolveDiscordAgentCommand("dado 2d6")?.cmd.name).toBe("dado");
    expect(resolveDiscordAgentCommand("/cortar 0:10 0:20")?.cmd.name).toBe("cortar");
  });
});
