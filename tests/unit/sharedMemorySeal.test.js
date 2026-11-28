import { describe, expect, it } from "vitest";
import { PeopleMemory, applyConsolidation, sealOf } from "../../src/core/memory/peopleMemory.js";

function memoryWith() {
  const mem = new PeopleMemory(null, { now: () => Date.UTC(2026, 10, 28, 15) });
  mem.save = () => {};
  const at = new Date(Date.UTC(2026, 10, 28)).toISOString();
  mem.data.notebooks["dm-ana|direct"] = {
    userId: "dm-ana",
    scope: "direct",
    name: "Ana",
    summary: "",
    facts: [
      { t: "Ana ama gatos", k: "gosto", imp: 2, s: "publico", at, seen: at },
      { t: "Ana está fazendo terapia", k: "saude", imp: 4, at, seen: at },
      { t: "Ana gosta do Pedro em segredo", k: "relacao", imp: 4, s: "secreto", at, seen: at }
    ],
    threads: [],
    dates: []
  };
  mem.data.notebooks["group:g2|group:g2"] = {
    userId: "group:g2",
    scope: "group:g2",
    name: null,
    summary: "",
    facts: [{ t: "Ana toca violão", k: "gosto", imp: 2, at, seen: at }],
    threads: [],
    dates: []
  };
  return mem;
}

describe("memória compartilhada com selo", () => {
  it("sigilo: PV fechado por padrão, saúde é segredo, grupo é público", () => {
    expect(sealOf({ t: "x" }, "direct")).toBe("pessoal");
    expect(sealOf({ t: "x", k: "saude" }, "direct")).toBe("secreto");
    expect(sealOf({ t: "x" }, "group:1")).toBe("publico");
    const nb = applyConsolidation({ facts: [], threads: [], dates: [] }, { fatos_novos: [{ texto: "gosta de pão", tipo: "gosto", sigilo: "publico" }, { texto: "tá doente", tipo: "saude", sigilo: "publico" }] }, { scope: "direct" });
    expect(nb.facts.find((f) => f.t === "gosta de pão").s).toBe("publico");
    expect(nb.facts.find((f) => f.t === "tá doente").s).toBe("pessoal");
  });

  it("no grupo, lembra da própria pessoa com cadeado no que é privado", () => {
    const lines = memoryWith().crossLines({ userId: "dm-ana", name: "Ana", scope: "group:g1", text: "oi teto" }).join("\n");
    expect(lines).toMatch(/Ana ama gatos/);
    expect(lines).toMatch(/Ana toca violão/); // dito em outro grupo
    expect(lines).toMatch(/🔒 Ana está fazendo terapia/);
    expect(lines).toMatch(/SEGREDO/);
  });

  it("sobre terceiros (citados), só o público chega; o privado nunca", () => {
    const lines = memoryWith().crossLines({ userId: "dm-bia", name: "Bia", scope: "direct", text: "a Ana vem hoje?" }).join("\n");
    expect(lines).toMatch(/Ana ama gatos/);
    expect(lines).not.toMatch(/terapia/);
    expect(lines).not.toMatch(/Pedro/);
    expect(lines).toMatch(/não conte/);
  });

  it("sem ninguém conhecido, não poluí o prompt", () => {
    expect(memoryWith().crossLines({ userId: "dm-zz", scope: "direct", text: "bom dia" })).toEqual([]);
  });
});
