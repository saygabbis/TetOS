import { describe, expect, it } from "vitest";
import { chooseInitiative } from "../../src/core/autonomy/initiative.js";

const H = 3_600_000;
const free = { mode: "online", activity: "vendo anime" };
const always = { chance: () => true };
const base = (person = {}, extra = {}) => ({
  availability: free,
  dayInfo: { minutesAwake: 300, minutesToBed: 300 },
  person: { userId: "dm-1", isOwner: true, name: "Gabbis", gapSinceUserMs: 5 * H, gapSinceAnyMs: 5 * H, followUps: [], ...person },
  row: { lastAt: 0, unanswered: 0, dayCount: 0, done: [] },
  rng: always,
  ...extra
});

describe("iniciativa", () => {
  it("só com gente próxima", () => {
    expect(chooseInitiative(base({ isOwner: false, intimacy: 0.2 }))).toBeNull();
    expect(chooseInitiative(base({ isOwner: false, intimacy: 0.8, followUps: ["perguntar como foi: prova"] }))).not.toBeNull();
  });
  it("não manda duas sem resposta, nem no meio de conversa, nem ocupada", () => {
    expect(chooseInitiative(base({}, { row: { lastAt: 0, unanswered: 1, dayCount: 0, done: [] } }))).toBeNull();
    expect(chooseInitiative(base({ gapSinceAnyMs: 20 * 60_000 }))).toBeNull();
    expect(chooseInitiative(base({}, { availability: { mode: "busy" } }))).toBeNull();
  });
  it("aniversário e pendência vencida têm prioridade e não repetem", () => {
    const bday = chooseInitiative(base({ followUps: ["hoje é aniversário — dar parabéns/carinho"] }));
    expect(bday.mode).toBe("carinho");
    const fu = chooseInitiative(base({ followUps: ["perguntar como foi: entrevista"] }));
    expect(fu.impulse).toContain("entrevista");
    expect(chooseInitiative(base({ followUps: ["perguntar como foi: entrevista"] }, { row: { lastAt: 0, unanswered: 0, dayCount: 0, done: [fu.reasonKey] } }))?.reasonKey).not.toBe(fu.reasonKey);
  });
});
