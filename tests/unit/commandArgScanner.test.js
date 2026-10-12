import { describe, expect, it } from "vitest";
import { scanCommandArgs } from "../../src/modules/chat/commandArgScanner.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";

const scan = (src) => scanCommandArgs(src, src.indexOf("(") + 1);

describe("scanCommandArgs", () => {
  it("lê argumentos simples e o fim do comando", () => {
    expect(scan('mensagem("oi", "id1")')).toEqual({ args: ["oi", "id1"], end: 'mensagem("oi", "id1")'.length });
  });

  it("parênteses e links Markdown dentro do texto não encerram o comando", () => {
    const src = 'mensagem("Salvei o [relatório](file:///C:/Users/eu/relatorio.docx) (versão final).")';
    expect(scan(src).args).toEqual(["Salvei o [relatório](file:///C:/Users/eu/relatorio.docx) (versão final)."]);
  });

  it("apóstrofo e aspas escapadas dentro do texto", () => {
    expect(scan(`mensagem("tá com d'água na mão")`).args).toEqual(["tá com d'água na mão"]);
    expect(scan('mensagem("ele disse \\"oi\\" e saiu")').args).toEqual(['ele disse "oi" e saiu']);
  });

  it("texto em várias linhas com bloco de código", () => {
    const src = 'mensagem("Feito:\n\n```powershell\nGet-ChildItem (Get-Location)\n```\n\nPronto.")';
    expect(scan(src).args[0]).toContain("```powershell\nGet-ChildItem (Get-Location)\n```");
  });

  it("argumento sem aspas e comando sem argumentos", () => {
    expect(scan("calar(todos)").args).toEqual(["todos"]);
    expect(scan("calar()").args).toEqual([]);
  });

  it("string sem fechamento devolve null (cai no leitor antigo)", () => {
    expect(scan('mensagem("sem fim')).toBeNull();
  });
});

describe("parseActionCommands com texto livre", () => {
  it("a mensagem com Markdown e link chega inteira", () => {
    const raw = 'mensagem("Pronto! Salvei em [relatório.docx](file:///C:/Users/eu/Desktop/relatorio.docx) (36 KB).")';
    expect(parseActionCommands(raw)).toEqual([
      { type: "message", text: "Pronto! Salvei em [relatório.docx](file:///C:/Users/eu/Desktop/relatorio.docx) (36 KB).", quoteId: null },
    ]);
  });

  it("o texto de uma mensagem não vira outro comando", () => {
    const raw = 'mensagem("use reagir(\\"x\\") se quiser")';
    expect(parseActionCommands(raw).map((a) => a.type)).toEqual(["message"]);
  });

  it("várias bolhas e comando de computador com apóstrofo", () => {
    const raw = ['mensagem("primeira")', 'mensagem("segunda (com parênteses)")', "computador(\"abrir o 'Bloco de Notas' e escrever 'oi (teste)'\")"].join("\n");
    const actions = parseActionCommands(raw);
    expect(actions.map((a) => a.type)).toEqual(["message", "message", "automate"]);
    expect(actions[1].text).toBe("segunda (com parênteses)");
    expect(actions[2].intent).toBe("abrir o 'Bloco de Notas' e escrever 'oi (teste)'");
  });

  it("comportamento antigo preservado (reação, figurinha, quote)", () => {
    expect(parseActionCommands('reagir("😂")')).toEqual([{ type: "react", emoji: "😂" }]);
    expect(parseActionCommands('mensagem("respondi aqui", "msg_abc123")')[0]).toMatchObject({ type: "message", text: "respondi aqui", quoteId: "msg_abc123" });
    expect(parseActionCommands('sticker("teto-linguinha")')[0]).toMatchObject({ type: "sticker", key: "teto-linguinha" });
  });
});
