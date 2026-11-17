import { describe, expect, it, vi } from "vitest";
import { resolveCommand, canonicalCommandText, COMMANDS } from "../../src/integrations/whatsapp/commands/commandCatalog.js";
import { formatHelp, formatHelpOverview } from "../../src/integrations/whatsapp/commands/commandHelp.js";
import { evaluateExpression, rollDice, runGeneralCommand } from "../../src/integrations/whatsapp/commands/generalCommands.js";
import { resolveAgentCommandText, runAgentChatCommand } from "../../src/integrations/whatsapp/commands/agentRunCommand.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";
import {
  describeDownloadDone,
  describeDownloadStart,
  friendlyDownloadError
} from "../../src/integrations/whatsapp/commands/mediaCommandService.js";

describe("catálogo de comandos", () => {
  it("acha nome oficial, apelido e corrige erro de digitação", () => {
    expect(resolveCommand(".sticker 5s")).toMatchObject({ kind: "known", cmd: { name: "sticker" }, args: ["5s"] });
    expect(resolveCommand(".fig")).toMatchObject({ kind: "known", cmd: { name: "sticker" } });
    expect(resolveCommand(".stiker")).toMatchObject({ cmd: { name: "sticker" } });
    expect(resolveCommand(".sticksr")).toMatchObject({ kind: "corrected", cmd: { name: "sticker" } });
    expect(resolveCommand(".custos")).toMatchObject({ cmd: { name: "gastos" } });
    expect(resolveCommand(".monitorarprec iphone")).toMatchObject({ kind: "corrected", cmd: { name: "monitorarpreco" } });
  });

  it("não confunde texto comum com comando", () => {
    expect(resolveCommand("oi tudo bem")).toBeNull();
    expect(resolveCommand("...")).toBeNull();
    expect(resolveCommand(".kkkkk")).toBeNull();
    expect(resolveCommand(". sticker")).toBeNull();
    expect(resolveCommand(".5")).toBeNull();
  });

  it("barra só vale com o nome oficial (pode ser de outro bot)", () => {
    expect(resolveCommand("/teto-ativar")).toMatchObject({ kind: "known", viaSlash: true });
    expect(resolveCommand("/s")).toBeNull();
  });

  it("palavra desconhecida vira unknown (pra responder no PV)", () => {
    expect(resolveCommand(".abacaxizeiro")).toMatchObject({ kind: "unknown", token: "abacaxizeiro" });
  });

  it("reescreve pro nome oficial", () => {
    expect(canonicalCommandText(resolveCommand(".audio https://youtu.be/x 320"))).toBe(".mp3 https://youtu.be/x 320");
  });

  it("apelidos não se repetem entre comandos", () => {
    const seen = new Map();
    for (const cmd of COMMANDS) {
      for (const key of [cmd.name, ...(cmd.aliases ?? [])]) {
        const k = key.toLowerCase();
        expect(seen.get(k) ?? cmd.name, `"${k}" em ${seen.get(k)} e ${cmd.name}`).toBe(cmd.name);
        seen.set(k, cmd.name);
      }
    }
  });
});

describe("help", () => {
  it("mostra todas as categorias e esconde comandos da dona pra quem não é", () => {
    const help = formatHelpOverview(".", { isOwner: false });
    for (const name of ["sticker", "download", "mp3", "convert", "ler", "transcrever", "lembrete", "calc", "monitorarpreco"]) {
      expect(help).toContain(`.${name}`);
    }
    expect(help).not.toContain(".gastos");
    expect(formatHelpOverview(".", { isOwner: true })).toContain(".gastos");
  });

  it("explica um comando pelo apelido e lista uma categoria", () => {
    expect(formatHelp(["s"], ".")).toMatch(/\.sticker/);
    expect(formatHelp(["baixar"], ".")).toMatch(/\.youtube/);
  });
});

describe("comandos de texto", () => {
  it("calcula com segurança", () => {
    expect(evaluateExpression("(2+3)*4")).toBe(20);
    expect(evaluateExpression("15% de 80")).toBe(12);
    expect(evaluateExpression("2^10")).toBe(1024);
    expect(evaluateExpression("1,5 x 2")).toBe(3);
    expect(() => evaluateExpression("process.exit()")).toThrow();
  });

  it("rola dado no formato NdM", () => {
    const out = rollDice("2d6");
    expect(out).toMatch(/2d6/);
  });

  it("roda .calc e .moeda pelo catálogo", async () => {
    const calc = await runGeneralCommand(resolveCommand(".calc 7*6"), { prefix: "." });
    expect(calc.text).toMatch(/42/);
    const coin = await runGeneralCommand(resolveCommand(".moeda"), { prefix: "." });
    expect(coin.text).toMatch(/cara|coroa/);
  });
});

describe("IA rodando comandos (comando(...))", () => {
  it("lê a ação no texto da IA", () => {
    const actions = parseActionCommands('mensagem("deixa comigo")\ncomando(".mp3 https://youtu.be/abc 320")');
    expect(actions).toEqual([
      { type: "message", text: "deixa comigo", quoteId: null },
      { type: "run_command", text: ".mp3 https://youtu.be/abc 320" }
    ]);
  });

  it("aceita com ou sem prefixo", () => {
    expect(resolveAgentCommandText("dado 2d20")?.cmd.name).toBe("dado");
    expect(resolveAgentCommandText("/calc 1+1")?.cmd.name).toBe("calc");
    expect(resolveAgentCommandText(".naoexiste")).toBeNull();
  });

  const item = { remoteJid: "x@g.us", userId: "u1", isGroup: true, isOwner: false };

  it("roda comando de texto e manda a resposta", async () => {
    const send = vi.fn(async () => {});
    const out = await runAgentChatCommand({ text: ".calc 2+2", runtime: { defaults: { commandPrefix: "." } }, item, send });
    expect(out.ok).toBe(true);
    expect(send.mock.calls[0][0].text).toMatch(/4/);
  });

  it("não roda comando da dona nem liga/desliga", async () => {
    const send = vi.fn();
    expect((await runAgentChatCommand({ text: ".gastos", runtime: {}, item, send })).ok).toBe(false);
    expect((await runAgentChatCommand({ text: ".desativar", runtime: {}, item, send })).ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("baixa link pelo serviço de mídia", async () => {
    const handleUrlCommand = vi.fn(async () => true);
    const out = await runAgentChatCommand({
      text: ".yt https://youtu.be/abc 720",
      runtime: { defaults: { commandPrefix: "." } },
      mediaCommands: { handleUrlCommand },
      item,
      send: vi.fn()
    });
    expect(out.ok).toBe(true);
    expect(handleUrlCommand).toHaveBeenCalledWith(
      expect.objectContaining({ parsedCommand: { command: "youtube", args: ["https://youtu.be/abc", "720"] } })
    );
  });

  it("comando de mídia sem mídia avisa em vez de falhar calado", async () => {
    const send = vi.fn(async () => {});
    const out = await runAgentChatCommand({
      text: ".ler",
      runtime: { defaults: { commandPrefix: "." } },
      mediaCommands: { runAgentMediaCommand: vi.fn() },
      item: { ...item, messageId: "3EB0AAAAAAAAAAAA" },
      send,
      resolveMedia: async () => null
    });
    expect(out).toMatchObject({ ok: false, reason: "no_media" });
    expect(send.mock.calls[0][0].text).toMatch(/preciso de uma mídia/);
  });

  it("usa a mídia marcada", async () => {
    const runAgentMediaCommand = vi.fn(async () => true);
    const out = await runAgentChatCommand({
      text: ".convert pdf",
      runtime: { defaults: { commandPrefix: "." } },
      mediaCommands: { runAgentMediaCommand },
      item: { ...item, quotedMessageId: "3EB0BBBBBBBBBBBB" },
      send: vi.fn(),
      resolveMedia: async (id) => (id === "3EB0BBBBBBBBBBBB" ? { media: { path: "/tmp/a.docx", type: "document" }, source: "reply" } : null)
    });
    expect(out.ok).toBe(true);
    expect(runAgentMediaCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "convert", args: ["pdf"], messageId: "3EB0BBBBBBBBBBBB" }));
  });
});

describe("mensagens de download", () => {
  it("confirma o que vai baixar e o que saiu", () => {
    expect(describeDownloadStart({ command: "youtube", mode: "mp4", quality: "720" }, { title: "Clipe", platform: "YouTube", duration: 125 }))
      .toMatch(/baixando vídeo · 720p do YouTube…[\s\S]*Clipe[\s\S]*2:05/);
    expect(describeDownloadStart({ command: "mp3", mode: "mp3", quality: "320" })).toMatch(/MP3 · 320 kbps/);
    expect(describeDownloadDone([{ fileName: "a.mp3", sizeBytes: 3 * 1024 * 1024 }], { title: "Música" })).toMatch(/✅ \*Música\*\nMP3 · 3,0 MB/);
  });

  it("traduz erro técnico", () => {
    expect(friendlyDownloadError(new Error("ERROR: Private video. Sign in"))).toMatch(/privado/);
    expect(friendlyDownloadError(new Error("fetch failed"))).toMatch(/fora do ar/);
  });
});
