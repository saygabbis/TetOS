import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keywordFocus, proposePatch, stackFiles } from "../../src/core/evolution/codePatcher.js";

function fakeLlm(replies) {
  const prompts = [];
  return {
    prompts,
    async generate(prompt) {
      prompts.push(prompt);
      return replies.shift() ?? "";
    }
  };
}

describe("patcher — ver mais código antes de desistir", () => {
  it("erro de biblioteca não vira arquivo dela", () => {
    const root = mkdtempSync(join(tmpdir(), "cp-"));
    try {
      mkdirSync(join(root, "src", "core"), { recursive: true });
      writeFileSync(join(root, "src", "core", "a.js"), "x\n");
      const stack = [
        `at x (${root}/node_modules/libsignal/src/session_cipher.js:10:5)`,
        `at y (${root}/src/core/a.js:1:1)`
      ].join("\n");
      expect(stackFiles(stack, root).map((f) => f.rel)).toEqual(["src/core/a.js"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("acha o trecho pelo assunto em arquivo grande", () => {
    const content = Array.from({ length: 3000 }, (_, i) => (i === 2400 ? "function contadorDeMensagens() {}" : `// linha ${i}`)).join("\n");
    expect(keywordFocus(content, "Corrigir contadorDeMensagens quebrado")).toEqual([2401]);
  });

  it("pede VER/PROCURAR, recebe e devolve o patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "cp-"));
    try {
      mkdirSync(join(root, "src", "modules"), { recursive: true });
      writeFileSync(join(root, "src", "modules", "b.js"), "export const limite = 2;\n");
      const llm = fakeLlm([
        "PROCURAR: limite =\nVER: src/modules/b.js",
        "ARQUIVO: src/modules/b.js\n<<<<<<< SEARCH\nexport const limite = 2;\n=======\nexport const limite = 3;\n>>>>>>> REPLACE\nEXPLICACAO: aumentei o limite"
      ]);
      const r = await proposePatch(llm, { goal: "aumentar limite", files: {}, root });
      expect(r.blocks).toHaveLength(1);
      expect(r.extraFiles["src/modules/b.js"]).toContain("limite = 2");
      expect(llm.prompts[1]).toContain("src/modules/b.js:1: export const limite = 2;");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
