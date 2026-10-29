import { describe, expect, it } from "vitest";
import { appraise, FeelingEngine } from "../../src/core/mind/feelings.js";
import { readTone } from "../../src/core/mind/toneReader.js";
import { Mind } from "../../src/core/mind/mind.js";

const clock = (start = Date.parse("2026-10-29T15:00:00Z")) => {
  let t = start;
  return { now: () => t, add: (ms) => (t += ms) };
};

describe("como as mensagens mexem com ela", () => {
  it("crise da dona deixa ela preocupada de verdade", () => {
    const r = appraise({ text: "se um dia eu me matar", tone: readTone("se um dia eu me matar"), isOwner: true });
    const worry = r.find((x) => x.feeling === "preocupacao");
    expect(worry.delta).toBeGreaterThan(0.7);
    expect(worry.cause).toMatch(/a Gabbis falou em se machucar/);
  });

  it("xingamento magoa, reclamação envergonha, carinho e elogio deixam feliz", () => {
    const feelings = (text, who = "Lucas") => appraise({ text, tone: readTone(text), who }).map((x) => x.feeling);
    expect(feelings("teto vc é muito chata e burra")).toContain("magoa");
    expect(feelings("para de rir, nada a ver")).toContain("vergonha");
    expect(feelings("te amo teto")).toEqual(expect.arrayContaining(["carinho", "alegria"]));
    expect(feelings("vc é muito inteligente, mandou bem")).toContain("orgulho");
    expect(feelings("KKKKKK mentira")).toContain("diversao");
    expect(appraise({ text: "para de rir", directed: false })).toEqual([]);
  });
});

describe("sentimentos e humor", () => {
  it("sentimento forte muda o humor, com motivo; com o tempo passa e volta pra rotina", () => {
    const c = clock();
    const f = new FeelingEngine(null, { now: c.now, baseMood: () => ({ mood: "de boa", energy: 0.7, valence: 0.6 }) });
    expect(f.mood().label).toBe("de boa");
    f.feel("preocupacao", 0.8, { cause: "a Gabbis falou em se machucar", userId: "dona", private: true });
    expect(f.mood().label).toBe("preocupada");
    expect(f.data.moods.at(-1)).toMatchObject({ to: "preocupada", reason: "a Gabbis falou em se machucar" });
    c.add(24 * 3_600_000);
    expect(f.level("preocupacao")).toBeLessThan(0.1);
    f.checkMood();
    expect(f.mood().label).toBe("de boa");
    expect(f.data.moods.at(-1).reason).toBe("passou com o tempo");
  });

  it("privacidade: motivo do privado de alguém só aparece pra essa pessoa", () => {
    const f = new FeelingEngine(null, { baseMood: () => ({ mood: "de boa", valence: 0.6 }) });
    f.feel("tristeza", 0.7, { cause: "o Lucas contou que terminou o namoro", userId: "lucas", private: true });
    expect(f.promptLines({ viewerUserId: "lucas" }).join("\n")).toMatch(/terminou o namoro/);
    const forOthers = f.promptLines({ viewerUserId: "outra" }).join("\n");
    expect(forOthers).not.toMatch(/namoro/);
    expect(forOthers).toMatch(/uma coisa pessoal que me contaram/);
    // dona vê o genérico também (não é dela)
    expect(f.report("", { viewerUserId: "dona", isOwner: true })).not.toMatch(/namoro/);
  });

  it("relatórios: agora, histórico de humor e como reagiu a algo", () => {
    const f = new FeelingEngine(null, { baseMood: () => ({ mood: "animada", valence: 0.8 }) });
    f.feel("orgulho", 0.5, { cause: "aprendi sobre UTAU" });
    f.feel("magoa", 0.8, { cause: "o Zé me xingou: «burra»", who: "Zé", private: false });
    expect(f.report("")).toMatch(/como eu tô agora:\* magoada/);
    expect(f.report("historico")).toMatch(/→ \*magoada\*: o Zé me xingou/);
    expect(f.report("utau")).toMatch(/orgulhosa \+50%: aprendi sobre UTAU/);
    expect(f.report("zé")).toMatch(/magoada/);
  });

  it("humor não fica pulando entre sentimentos parecidos do mesmo desabafo", () => {
    const f = new FeelingEngine(null, { baseMood: () => ({ mood: "de boa", valence: 0.6 }) });
    f.feel("tristeza", 0.5, { cause: "a Gabbis tava triste" });
    expect(f.mood().label).toBe("triste");
    f.feel("preocupacao", 0.55, { cause: "a Gabbis tava mal" });
    expect(f.mood().label).toBe("triste"); // diferença pequena: mantém
    f.feel("preocupacao", 0.5, { cause: "a Gabbis tava mal de novo" });
    expect(f.mood().label).toBe("preocupada"); // passou com folga: troca
    expect(f.data.moods.filter((m) => m.to === "preocupada")).toHaveLength(1);
  });

  it("saudade quando a dona some; passa quando ela volta", () => {
    const c = clock();
    const f = new FeelingEngine(null, { now: c.now, baseMood: () => ({ mood: "de boa", valence: 0.6 }) });
    f.noteOwner();
    c.add(13 * 3_600_000);
    f.tickIdle({ lastActivityAt: c.now() });
    expect(f.level("saudade")).toBeGreaterThan(0);
    f.noteOwner();
    expect(f.level("saudade")).toBeLessThan(0.05);
  });
});

describe("avisos pra dona", () => {
  it("tudo / importante / nada", async () => {
    const mind = new Mind({ dir: null });
    expect(mind.settings.avisos).toBe("importante");
    expect(mind.shouldNotify("info")).toBe(false);
    expect(mind.shouldNotify("decisao")).toBe(true);
    expect(mind.shouldNotify("alerta")).toBe(true);
    expect(await mind.command("avisos tudo", { isOwner: true })).toMatch(/avisos: tudo/);
    expect(mind.shouldNotify("info")).toBe(true);
    await mind.command("avisos off", { isOwner: true });
    expect(mind.shouldNotify("alerta")).toBe(false);
    expect(await mind.command("avisos talvez", { isOwner: true })).toMatch(/use:/);
    expect(await mind.command("avisos", { isOwner: false })).toMatch(/Gabbis/);
  });
});

describe("mente — sentimentos no turno", () => {
  it("o que chegou entra no prompt como sentimento, e mexe no humor", async () => {
    const mind = new Mind({ dir: null, life: { mood: () => ({ mood: "de boa", energy: 0.7, valence: 0.6 }) } });
    const text = "se um dia eu me matar, avisa as pessoas";
    const turn = await mind.prepareTurn({ input: text, userId: "dona", chatId: "x", isOwner: true, speakerName: "Gabbis", tone: readTone(text) });
    expect(turn.lines.join("\n")).toMatch(/COMO VOCÊ ESTÁ SE SENTINDO[\s\S]*preocupada/);
    expect(mind.feelings.mood().label).toBe("preocupada");
    expect(await mind.command("humor historico", { isOwner: true, userId: "dona" })).toMatch(/preocupada/);
  });
});
