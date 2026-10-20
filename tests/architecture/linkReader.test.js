import { describe, expect, it } from "vitest";
import { extractLinks, formatLinksForPrompt, readableText } from "../../src/modules/web/linkReader.js";
import { detectAgentUrlDownloadIntent } from "../../src/core/media/agentUrlDownloadIntent.js";

describe("leitura de links", () => {
  it("extrai links sem a pontuação do fim", () => {
    expect(extractLinks("olha isso https://youtu.be/abc). e https://x.com/a/status/1!")).toEqual(["https://youtu.be/abc", "https://x.com/a/status/1"]);
  });

  it("pega os parágrafos e ignora menu, script e atributo com '>'", () => {
    const html = `<html><body><nav>Menu Home Login</nav><script>var x = "<p>não</p>";</script>
      <article><p data-mw='{"a":"b>c"}'>Kasane Teto é uma cantora virtual criada como piada de primeiro de abril em 2008 [ 1 ] .</p>
      <p>Depois virou banco de voz de verdade no UTAU, e hoje também existe no Synthesizer V , com muitos fãs.</p>
      <p>Ela é conhecida pelas brocas vermelhas e pelo amor por baguete, e aparece em vários memes.</p></article></body></html>`;
    const text = readableText(html);
    expect(text).toContain("Kasane Teto é uma cantora virtual");
    expect(text).not.toMatch(/Menu|var x|data-mw|\[ 1 \]/);
    expect(text).toContain("Synthesizer V,");
  });

  it("monta o bloco do prompt e avisa quando não abriu", () => {
    const block = formatLinksForPrompt([
      { url: "u", site: "YouTube", kind: "vídeo", author: "Fulano", title: "Teto cover", details: ["duração 3:10"], transcript: "la la la" },
      { url: "v", failed: true }
    ]);
    expect(block).toContain("YouTube (vídeo) de Fulano: «Teto cover»");
    expect(block).toContain("legenda");
    expect(block).toContain("não abriu");
    expect(formatLinksForPrompt([])).toBeNull();
  });
});

describe("download por link só com pedido", () => {
  it.each(["https://youtu.be/abc", "olha esse vídeo https://youtu.be/abc kkk", "viu isso? https://x.com/a/status/1"])("não baixa: %s", (t) => {
    expect(detectAgentUrlDownloadIntent(t)).toBeNull();
  });
  it.each(["baixa esse https://youtu.be/abc", "manda esse vídeo aqui https://youtu.be/abc", "https://youtu.be/abc em mp3", "thumb https://youtu.be/abc"])("baixa: %s", (t) => {
    expect(detectAgentUrlDownloadIntent(t)?.url).toBe("https://youtu.be/abc");
  });
});
