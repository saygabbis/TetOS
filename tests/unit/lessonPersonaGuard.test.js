import { describe, expect, it } from "vitest";
import { LessonBook, personaGuardKind } from "../../src/core/mind/lessonBook.js";
import { studyTopic } from "../../src/core/mind/research.js";

describe("lições não apagam o jeito da Teto", () => {
  it("regras de assistente viram uma regra no jeito dela, e as úteis ficam", () => {
    const b = new LessonBook(null);
    b.data = {
      lessons: [
        { id: "a", rule: "Diante de hostilidade, estabeleça o limite e encerre sem sarcasmo.", strength: 0.9, scope: "geral" },
        { id: "b", rule: "Diante de provocação, responda com calma ou encerre sem alimentar a briga.", strength: 0.6, scope: "geral" },
        { id: "c", rule: "Não use apelidos carinhosos sem vínculo claramente estabelecido.", strength: 0.7, scope: "geral" },
        { id: "d", rule: "Quando o contexto sexual estiver claro, recuse uma vez e encerre sem flertar.", strength: 0.5, scope: "geral" },
        { id: "e", rule: "Não repita perguntas já respondidas; deixe a conversa seguir.", strength: 0.5, scope: "geral" }
      ],
      retired: []
    };
    b.applyPersonaGuard();
    const rules = b.lessons.map((l) => l.rule);
    expect(rules).toContain("Não repita perguntas já respondidas; deixe a conversa seguir.");
    expect(rules.some((r) => /encerre sem sarcasmo|responda com calma/.test(r))).toBe(false);
    expect(b.lessons.filter((l) => l.source === "curadoria")).toHaveLength(3);
    expect(b.data.retired).toHaveLength(4);
  });

  it("lição nova de assistente reforça a versão dela em vez de entrar", () => {
    const b = new LessonBook(null);
    b.save = () => {};
    b.add({ rule: "Não use risada nem provocação automática; responda ao tom." });
    b.add({ rule: "Pare de provocar e encerre a troca com firmeza." });
    expect(b.lessons.every((l) => l.source === "curadoria")).toBe(true);
    expect(personaGuardKind("Em desabafo, não mande figurinha")).toBeNull();
  });
});

describe("estudo acha material na Wikipédia pelo nome do artigo", () => {
  it("busca pelos títulos que o modelo sugere antes da frase longa", async () => {
    const asked = [];
    const search = async (q) => {
      asked.push(q);
      return q === "Suplemento pré-treino" ? [{ url: "https://pt.wikipedia.org/wiki/Suplemento_pré-treino", title: "Suplemento pré-treino", snippet: "mistura de cafeína..." }] : [];
    };
    const llm = {
      generate: async (prompt) =>
        /artigos da Wikipédia/.test(prompt)
          ? '{"pt":["Suplemento pré-treino"],"en":["Pre-workout"]}'
          : '{"tema":"pré-treino","resumo":"é um suplemento.","fatos":["tem cafeína"],"palavras_chave":["cafeína"],"fonte_principal":"https://pt.wikipedia.org/wiki/Suplemento_pré-treino","opiniao":"eita","confianca":0.8}'
    };
    const r = await studyTopic({ topic: "Como o pré-treino afeta o corpo e o desempenho nos exercícios", search, llm });
    expect(asked[0]).toBe("Suplemento pré-treino");
    expect(r?.topic).toBe("pré-treino");
  });
});
