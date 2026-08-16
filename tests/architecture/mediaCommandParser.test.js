import { describe, expect, it } from "vitest";
import {
  formatWhatsAppHelpText,
  formatMissingMediaCommandHint,
  isUrlMediaCommand,
  parseNaturalWhatsAppMediaCommand,
  parseWhatsAppCommand
} from "../../src/integrations/whatsapp/mediaCommandParser.js";

describe("media command parser", () => {
  it("normalizes supported media command aliases", () => {
    expect(parseWhatsAppCommand(".sticker 10s")).toEqual({
      command: "sticker",
      args: ["10s"]
    });
    expect(parseWhatsAppCommand(".stiker")).toEqual({
      command: "sticker",
      args: []
    });
    expect(parseWhatsAppCommand(".otimizar")).toEqual({
      command: "optimize",
      args: []
    });
    expect(parseWhatsAppCommand(".remove-bg verde forte")).toEqual({
      command: "removebg",
      args: ["verde", "forte"]
    });
  });

  it("parses download and convert commands with aliases", () => {
    expect(parseWhatsAppCommand(".yt https://youtu.be/abc mp3")).toEqual({
      command: "youtube",
      args: ["https://youtu.be/abc", "mp3"]
    });
    expect(parseWhatsAppCommand(".x https://x.com/u/status/1 mp4")).toEqual({
      command: "twitter",
      args: ["https://x.com/u/status/1", "mp4"]
    });
    expect(parseWhatsAppCommand(".rd https://reddit.com/r/a/comments/b/c user")).toEqual({
      command: "reddit",
      args: ["https://reddit.com/r/a/comments/b/c", "user"]
    });
    expect(parseWhatsAppCommand(".thumb https://youtube.com/watch?v=abc")).toEqual({
      command: "thumbnail",
      args: ["https://youtube.com/watch?v=abc"]
    });
    expect(parseWhatsAppCommand(".dl https://twitch.tv/clip/abc")).toEqual({
      command: "download",
      args: ["https://twitch.tv/clip/abc"]
    });
    expect(parseWhatsAppCommand(".converter mp4")).toEqual({
      command: "convert",
      args: ["mp4"]
    });
  });

  it("flags url media commands", () => {
    expect(isUrlMediaCommand("youtube")).toBe(true);
    expect(isUrlMediaCommand("thumbnail")).toBe(true);
    expect(isUrlMediaCommand("convert")).toBe(false);
  });

  it("ignores non-command text and slash activation commands", () => {
    expect(parseWhatsAppCommand("oi .sticker")).toBeNull();
    expect(parseWhatsAppCommand("/teto-ativar")).toBeNull();
  });

  it("parses commands after a leading mention or bidi mark", () => {
    expect(parseWhatsAppCommand("@teto .sticker")).toEqual({
      command: "sticker",
      args: []
    });
    expect(parseWhatsAppCommand("\u200e.sticker 8s")).toEqual({
      command: "sticker",
      args: ["8s"]
    });
  });

  it("formats help text with the configured prefix", () => {
    const help = formatWhatsAppHelpText(".");
    expect(help).toMatch(/\.sticker/);
    expect(help).toMatch(/\.youtube/);
    expect(help).toMatch(/\.thumb/);
    expect(help).toMatch(/\.convert/);
    expect(help).toMatch(/\*Comandos TetOS\*/);
    expect(help).toMatch(/Download de links/);
    expect(help).toMatch(/Ativar \/ desativar a Teto/);
    expect(help).not.toMatch(/última mídia/);
    expect(help).not.toMatch(/Comandos da IA/);
    expect(help).not.toMatch(/youtube\("url"/);
    expect(formatWhatsAppHelpText("!")).toMatch(/!toimg/);
  });

  it("parses short natural media requests without going through chat", () => {
    expect(parseNaturalWhatsAppMediaCommand("faz uma figurinha")).toEqual({
      command: "sticker",
      args: []
    });
    expect(parseNaturalWhatsAppMediaCommand("figurinha")).toEqual({
      command: "sticker",
      args: []
    });
    expect(parseNaturalWhatsAppMediaCommand("faz uma figurinha disso")).toEqual({
      command: "sticker",
      args: []
    });
    expect(parseNaturalWhatsAppMediaCommand("pode fazer uma figurinha")).toEqual({
      command: "sticker",
      args: []
    });
    expect(parseNaturalWhatsAppMediaCommand("tira o fundo")).toEqual({
      command: "removebg",
      args: []
    });
    expect(parseNaturalWhatsAppMediaCommand("adorei essa figurinha kkk")).toBeNull();
    expect(parseNaturalWhatsAppMediaCommand("oi .sticker")).toBeNull();
  });

  it("asks to reply or use a caption when the command has no media", () => {
    expect(formatMissingMediaCommandHint("sticker", ".")).toMatch(/reply/);
    expect(formatMissingMediaCommandHint("sticker", ".")).toMatch(/\.sticker/);
    expect(formatMissingMediaCommandHint("convert", ".")).toMatch(/\.convert mp4/);
  });
});
