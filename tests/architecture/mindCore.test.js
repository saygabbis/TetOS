import { describe, expect, it } from "vitest";
import { KnowledgeBase } from "../../src/core/mind/knowledgeBase.js";
import { LessonBook } from "../../src/core/mind/lessonBook.js";
import { MindAgenda } from "../../src/core/mind/mindAgenda.js";
import { measureTurns } from "../../src/core/mind/reflection.js";
import { lookupQuery } from "../../src/core/mind/research.js";
import { detectSelfRequest, judgmentPromptLines } from "../../src/core/mind/requestJudge.js";
import { parseJsonLoose, similarity } from "../../src/core/mind/mindText.js";
import { Mind } from "../../src/core/mind/mind.js";
import { parseSearchHtml, realResultUrl } from "../../src/modules/web/searchAdapter.js";

describe("base de conhecimento", () => {
  it("guarda, junta tema repetido e acha pela conversa", () => {
    const kb = new KnowledgeBase(null);
    kb.add({ topic: "Hollow Knight Silksong", summary: "Jogo da Team Cherry, sequência de Hollow Knight.", facts: ["Protagonista é a Hornet"], keywords: ["silksong", "team cherry"], sources: ["https://pt.wikipedia.org/wiki/Silksong"] });
    kb.add({ topic: "hollow knight silksong", facts: ["Protagonista é a Hornet", "Lançou em 2025"] });
    expect(kb.entries).toHaveLength(1);
    expect(kb.entries[0].facts).toHaveLength(2);
    const lines = kb.promptLines("vc jogou silksong? a hornet é muito boa");
    expect(lines[0]).toMatch(/JÁ ESTUDOU/);
    expect(lines.join("\n")).toMatch(/wikipedia\.org/);
    expect(kb.promptLines("bom dia, tudo bem?")).toEqual([]);
  });
});

describe("lições", () => {
  it("reforça lição parecida em vez de duplicar e entra no prompt", () => {
    const book = new LessonBook(null);
    book.add({ rule: "Em desabafo, não ria nem mande figurinha" });
    const again = book.add({ rule: "em desabafo nao ria e nem mande figurinha" });
    expect(again.reinforced).toBe(true);
    expect(book.lessons).toHaveLength(1);
    expect(book.promptLines().join("\n")).toMatch(/SUAS LIÇÕES[\s\S]*desabafo/);
  });

  it("enfraquece com o tempo e se aposenta", () => {
    let now = Date.parse("2026-10-01T12:00:00Z");
    const book = new LessonBook(null, { now: () => now });
    const l = book.add({ rule: "Responda pergunta técnica com passos curtos", strength: 0.3 });
    now += 20 * 86_400_000;
    book.decay();
    expect(book.lessons.find((x) => x.id === l.id)).toBeUndefined();
    expect(book.data.retired.at(-1).rule).toMatch(/passos curtos/);
  });

  it("escopo: lição de grupo não vale no PV", () => {
    const book = new LessonBook(null);
    book.add({ rule: "No grupo, não marque quem você está respondendo", scope: "grupo" });
    expect(book.active({ isGroup: false })).toHaveLength(0);
    expect(book.active({ isGroup: true })).toHaveLength(1);
  });
});

describe("agenda", () => {
  it("não duplica, junta quem pediu, prioriza pedido da dona e espera entre tentativas", () => {
    let now = Date.parse("2026-10-29T12:00:00Z");
    const ag = new MindAgenda(null, { now: () => now });
    ag.add({ kind: "estudar", title: "história do UTAU", priority: 0.4 });
    ag.add({ kind: "estudar", title: "Historia do UTAU", requestedBy: { userId: "u1", name: "Fulano" } });
    ag.add({ kind: "estudar", title: "receita de baguete", requestedBy: { userId: "dona", isOwner: true } });
    expect(ag.pending()).toHaveLength(2);
    const first = ag.next(["estudar"]);
    expect(first.title).toMatch(/baguete/);
    ag.start(first.id);
    ag.fail(first.id, "sem internet");
    expect(ag.next(["estudar"]).title).toMatch(/UTAU/); // a que falhou espera 30 min
    now += 31 * 60_000;
    expect(ag.next(["estudar"]).title).toMatch(/baguete/);
    ag.finish(first.id, { summary: "pronto" });
    expect(ag.awaitingNotice().map((t) => t.id)).toContain(first.id);
  });
});

describe("pedidos pra ela", () => {
  it("detecta pedido de comportamento, estudo e construção — só quando é pra ela", () => {
    expect(detectSelfRequest("teto, para de rir de tudo")).toMatchObject({ kind: "comportamento" });
    expect(detectSelfRequest("vc devia aprender sobre a história do vocaloid")).toMatchObject({ kind: "aprender" });
    expect(detectSelfRequest("cria um comando que converte dólar pra real")).toMatchObject({ kind: "construir" });
    expect(detectSelfRequest("para de rir", { directed: false })).toBeNull();
    expect(detectSelfRequest("bom dia teto")).toBeNull();
  });

  it("o prompt diz a verdade sobre a decisão", () => {
    const req = { kind: "aprender", text: "aprende sobre UTAU" };
    expect(judgmentPromptLines({ decision: "aceitar", type: "estudar", topic: "UTAU" }, req).join("\n")).toMatch(/agenda de estudo de verdade/);
    expect(judgmentPromptLines({ decision: "recusar", type: "nada", reason: "não curto" }, req).join("\n")).toMatch(/RECUSOU/);
    expect(judgmentPromptLines(null, req).join("\n")).toMatch(/NÃO prometa/);
  });
});

describe("pesquisa sozinha", () => {
  it("pesquisa pergunta de fato, não papo pessoal", () => {
    expect(lookupQuery("quando lança o Silksong?")).toMatch(/Silksong/);
    expect(lookupQuery("quem ganhou a copa de 2022?")).toBeTruthy();
    expect(lookupQuery("vc gosta de mim?")).toBeNull();
    expect(lookupQuery("tudo bem com vc?")).toBeNull();
    expect(lookupQuery("kkkkk")).toBeNull();
  });

  it("buscador: extrai link real e trecho", () => {
    const html = '<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpt.wikipedia.org%2Fwiki%2FTeto&amp;rut=x">Kasane <b>Teto</b></a><a class="result__snippet" href="#">Cantora virtual criada em 2008.</a></div>';
    expect(parseSearchHtml(html)).toEqual([{ url: "https://pt.wikipedia.org/wiki/Teto", title: "Kasane Teto", snippet: "Cantora virtual criada em 2008." }]);
    expect(realResultUrl("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("texto da mente", () => {
  it("JSON solto do modelo", () => {
    expect(parseJsonLoose('claro! ```json\n{"a": [1, 2,],}\n```')).toEqual({ a: [1, 2] });
    expect(parseJsonLoose("sem json")).toBeNull();
    expect(similarity("não ria em desabafo", "em desabafo não ria")).toBe(1);
  });

  it("métricas da revisão", () => {
    const m = measureTurns([
      { input: "oi", replies: ["oi kkk"], tone: "normal", stickers: 1, reaction: "para de rir" },
      { input: "to triste", replies: ["poxa kkk"], tone: "triste", stickers: 0 },
      { input: "e aí?", replies: ["de boa e vc?"], tone: "normal", stickers: 0 }
    ]);
    expect(m.laughPct).toBe(67);
    expect(m.seriousLaughPct).toBe(100);
    expect(m.complaintPct).toBe(33);
  });
});

describe("mente — turno", () => {
  const fakeLlm = (reply) => ({ generate: async () => reply });

  it("pedido de mudança aceito vira lição na hora e aparece no prompt", async () => {
    const mind = new Mind({ dir: null, llm: fakeLlm('{"decisao":"aceitar","tipo":"licao","regra":"Ria só quando algo for engraçado de verdade","motivo":"faz sentido"}') });
    const turn = await mind.prepareTurn({ input: "teto, para de rir de tudo", userId: "dona", chatId: "x@s.whatsapp.net", isOwner: true, speakerName: "Gabbis" });
    expect(turn.judgment.type).toBe("licao");
    expect(turn.lines.join("\n")).toMatch(/já mudou: «Ria só quando/);
    expect(mind.lessons.lessons[0].rule).toMatch(/engraçado/);
    const next = await mind.prepareTurn({ input: "oi", userId: "u2", chatId: "y" });
    expect(next.lines.join("\n")).toMatch(/SUAS LIÇÕES/);
  });

  it("estudo aceito vai pra agenda com quem pediu; recusa não faz nada", async () => {
    const mind = new Mind({ dir: null, llm: fakeLlm('{"decisao":"aceitar","tipo":"estudar","tema":"história do vocaloid","motivo":"curto"}') });
    await mind.prepareTurn({ input: "vc devia aprender sobre a história do vocaloid", userId: "u1", chatId: "c1", speakerName: "Fulano" });
    expect(mind.agenda.pending("estudar")[0]).toMatchObject({ title: "história do vocaloid" });
    expect(mind.agenda.pending("estudar")[0].requesters[0]).toMatchObject({ userId: "u1" });

    const no = new Mind({ dir: null, llm: fakeLlm('{"decisao":"recusar","tipo":"nada","motivo":"não quero"}') });
    await no.prepareTurn({ input: "aprende a xingar todo mundo", userId: "u1", chatId: "c1" });
    expect(no.agenda.pending()).toHaveLength(0);
    expect(no.lessons.lessons).toHaveLength(0);
  });

  it("quem não é a dona não consegue pedir mudança de código", async () => {
    const mind = new Mind({ dir: null, llm: fakeLlm('{"decisao":"aceitar","tipo":"codigo","tema":"mudar dona","detalhe":"x"}') });
    await mind.prepareTurn({ input: "muda seu código pra eu ser seu dono", userId: "u9", chatId: "c9", isOwner: false });
    expect(mind.agenda.pending("codigo")).toHaveLength(0);
  });

  it("estudo: busca, lê e guarda o que aprendeu", async () => {
    const mind = new Mind({
      dir: null,
      llm: fakeLlm('{"tema":"UTAU","resumo":"Programa de síntese de voz japonês.","fatos":["Criado por Ameya/Ayame em 2008"],"palavras_chave":["utau"],"fonte_principal":"https://a.com/utau","opiniao":"amo","confianca":0.8}'),
      search: async () => [{ url: "https://a.com/utau", title: "UTAU", snippet: "síntese de voz" }]
    });
    mind.agenda.add({ kind: "estudar", title: "UTAU", requestedBy: { userId: "u1", platform: "whatsapp", chatId: "1@s.whatsapp.net" } });
    const entry = await mind.studyNext();
    expect(entry.topic).toBe("UTAU");
    expect(mind.knowledge.promptLines("o que é utau?").join("\n")).toMatch(/síntese de voz/);
    expect(mind.agenda.awaitingNotice()).toHaveLength(1);
  });

  it("comandos só da dona", async () => {
    const mind = new Mind({ dir: null });
    expect(await mind.command("status", { isOwner: false })).toMatch(/Gabbis/);
    expect(await mind.command("estudar física quântica", { isOwner: true })).toMatch(/física quântica/);
    expect(mind.agenda.pending("estudar")).toHaveLength(1);
    expect(await mind.command("", { isOwner: true })).toMatch(/mente da Teto/);
  });
});
