import { describe, expect, it } from "vitest";
import { MusicBook, isTetoRelated, mentionsUrl } from "../../src/core/music/musicBook.js";
import { chooseInitiative } from "../../src/core/autonomy/initiative.js";

const fakeSearch = async (q) => [
  { id: "sqK-jh4TDXo", url: "https://www.youtube.com/watch?v=sqK-jh4TDXo", title: "Machine Love (feat. Kasane Teto)", channel: "Jamie Paige", duration: 287, views: 3e7 }
];
const fakeReader = { read: async () => ({ title: "Machine Love (feat. Kasane Teto)", text: "lyrics: I'm a machine, but I love", transcript: "i'm a machine but i love you" }) };
const fakeLlm = {
  generate: async () =>
    JSON.stringify({ about: "uma máquina que quer amar de verdade", vibe: "electropop fofo", opinion: "é a minha cara, choro todo vez", lines: ["I'm a machine, but I love"], fun: "viralizou demais" })
};

describe("caderno de música da Teto", () => {
  it("começa com as músicas dela e aprende ouvindo (acha o vídeo, lê, anota)", async () => {
    const book = new MusicBook(null);
    expect(book.songs().length).toBeGreaterThanOrEqual(5);
    const song = book.pickToLearn();
    const learned = await book.learn(song, { llm: fakeLlm, reader: fakeReader, searchYoutube: fakeSearch });
    expect(learned.url).toMatch(/youtube/);
    expect(learned.opinion).toMatch(/minha cara/);
    expect(learned.lines.length).toBe(1);
  });

  it("entra no prompt quando o papo é de música e marca o que já mandou", async () => {
    const book = new MusicBook(null);
    await book.learn(book.find("Machine Love"), { llm: fakeLlm, reader: fakeReader, searchYoutube: fakeSearch });
    const lines = book.promptLines("teto canta machine love pra mim", { chatId: "c1" });
    expect(lines.join("\n")).toMatch(/Machine Love.*link: https/);
    expect(book.shareCandidate("c1")?.title).toBe("Machine Love");
    book.noteSentText("olha essa https://youtu.be/sqK-jh4TDXo amo", "c1");
    expect(book.shareCandidate("c1")).toBeNull();
    expect(book.promptLines("bom dia", { chatId: "c1" })).toEqual([]);
  });

  it("guarda música que o pessoal fez com a voz dela", () => {
    const book = new MusicBook(null);
    book.noteFromLinks([{ url: "https://www.youtube.com/watch?v=abcdefghijk", site: "YouTube", title: "【重音テトSV】minha musica nova", author: "Produtor X" }], { who: "Ana", chatId: "g" });
    const s = book.songs().find((x) => x.url?.includes("abcdefghijk"));
    expect(s.source).toBe("pessoal");
    expect(s.sentBy).toBe("Ana");
  });

  it("detecta Teto e link do YouTube em formatos diferentes", () => {
    expect(isTetoRelated("Kasane Teto cover")).toBe(true);
    expect(isTetoRelated("tetoris")).toBe(false);
    expect(mentionsUrl("youtube.com/shorts/sqK-jh4TDXo", "https://www.youtube.com/watch?v=sqK-jh4TDXo")).toBe(true);
  });

  it("iniciativa pode mandar música (com link e opinião) pra quem é próximo", () => {
    const song = { url: "https://www.youtube.com/watch?v=sqK-jh4TDXo", title: "Machine Love", artist: "Jamie Paige", opinion: "amo", source: "oficial" };
    let picked = null;
    for (let i = 0; i < 400 && !picked; i += 1) {
      const d = chooseInitiative({
        now: Date.UTC(2026, 10, 28, 15) + i * 300_000,
        availability: { mode: "online", activity: "de boa" },
        dayInfo: { minutesAwake: 300, minutesToBed: 400 },
        person: { userId: "u", isOwner: true, gapSinceUserMs: 5 * 3_600_000, gapSinceAnyMs: 5 * 3_600_000, name: "Gabbis" },
        share: { song }
      });
      if (d?.mode === "mostrar música") picked = d;
    }
    expect(picked?.impulse).toMatch(/sqK-jh4TDXo/);
  });
});
