import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushJsonWrites, readJson, writeJsonDeferred } from "../../src/infra/utils/fileStore.js";

const dir = () => mkdtempSync(join(tmpdir(), "tetos-fs-"));

describe("fileStore", () => {
  it("padrão é copiado (stores não compartilham o mesmo objeto)", () => {
    const DEFAULT = { a: { n: 0 } };
    const x = readJson(join(dir(), "nao-existe.json"), DEFAULT);
    x.a.n = 5;
    expect(DEFAULT.a.n).toBe(0);
  });

  it("JSON corrompido não derruba: volta o padrão e guarda o arquivo ruim", () => {
    const d = dir(); const p = join(d, "x.json");
    writeFileSync(p, "{ quebrado");
    expect(readJson(p, { ok: true })).toEqual({ ok: true });
    expect(readdirSync(d).some((f) => f.startsWith("x.json.corrupt-"))).toBe(true);
  });

  it("gravações coalescidas: várias chamadas viram uma, com o estado mais recente", () => {
    const p = join(dir(), "y.json");
    const state = { n: 0 };
    for (let i = 1; i <= 50; i++) { state.n = i; writeJsonDeferred(p, state); }
    flushJsonWrites();
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ n: 50 });
  });
});
