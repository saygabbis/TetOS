import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyConsolidation, forget, parseModelJson, PeopleMemory } from "../../src/core/memory/peopleMemory.js";

const NOW = Date.parse("2026-10-20T15:00:00-03:00");
const DAY = 86_400_000;

describe("caderno de memória", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "people-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lê JSON embrulhado pelo modelo", () => {
    expect(parseModelJson('claro!\n```json\n{"resumo":"oi"}\n```')).toEqual({ resumo: "oi" });
    expect(parseModelJson("sem json")).toBeNull();
  });

  it("junta fato repetido, corrige fato errado e guarda pendência com data", () => {
    let nb = { userId: "dm-1", scope: "direct", name: "Gabbis", summary: "", mood: "", facts: [], threads: [], dates: [] };
    nb = applyConsolidation(nb, {
      resumo: "Gabbis tá cansada do trabalho.",
      fatos_novos: [{ texto: "Ama pitaya", tipo: "gosto", importancia: 3 }, { texto: "Mora em SP", importancia: 2 }],
      pendencias: [{ texto: "entrevista de emprego", quando: "2026-10-21" }],
      datas: [{ texto: "aniversário", dia: "03-12" }]
    }, { now: NOW });
    nb = applyConsolidation(nb, { fatos_novos: [{ texto: "ama pitaya!", importancia: 4 }], fatos_errados: ["Mora em SP"] }, { now: NOW + DAY });
    expect(nb.facts.map((f) => f.t)).toEqual(["Ama pitaya"]);
    expect(nb.facts[0].imp).toBe(4);
    expect(nb.threads[0]).toMatchObject({ t: "entrevista de emprego", due: "2026-10-21", done: null });
    expect(nb.dates).toEqual([{ t: "aniversário", md: "03-12" }]);
  });

  it("esquece detalhe bobo antigo e pendência vencida há muito tempo", () => {
    const old = new Date(NOW - 60 * DAY).toISOString();
    const nb = forget({
      facts: [{ t: "comeu miojo", imp: 1, at: old, seen: old }, { t: "tem um gato", imp: 4, at: old, seen: old }],
      threads: [{ t: "prova", due: "2026-08-01", at: old, done: null }],
      dates: []
    }, { now: NOW });
    expect(nb.facts.map((f) => f.t)).toEqual(["tem um gato"]);
    expect(nb.threads).toEqual([]);
  });

  it("consolida quando a conversa esfria e mostra no prompt só no escopo certo", async () => {
    let now = NOW;
    const llm = { generate: async () => '{"resumo":"Gabbis contou do dia puxado.","fatos_novos":[{"texto":"Brigou com a chefe","tipo":"trabalho","importancia":3}],"pendencias":[{"texto":"entrevista","quando":"2026-10-20"}]}' };
    const mem = new PeopleMemory(join(dir, "people.json"), { llm, now: () => now });
    for (const t of ["oi teto", "briguei com a chefe hoje", "amanhã não, hoje tenho entrevista"]) mem.record({ userId: "dm-1", name: "Gabbis", text: t });
    mem.record({ userId: "dm-1", role: "teto", text: "que dia hein" });
    expect(await mem.consolidateDue()).toBe(0);
    now += 13 * 60_000;
    expect(await mem.consolidateDue()).toBe(1);
    const lines = mem.promptLines("dm-1", "direct", { name: "Gabbis" }).join("\n");
    expect(lines).toContain("Brigou com a chefe");
    expect(lines).toContain("pendente: entrevista (é hoje)");
    expect(mem.promptLines("dm-1", "group:123@g.us")).toEqual([]);
    expect(mem.followUps("dm-1")).toEqual(["perguntar como foi: entrevista"]);
  });
});
