import { contextualSeed, pick, chance } from "../brain/rng.js";

const STATUSES = ["pending", "in_progress", "done", "failed", "delayed", "early", "cancelled"];

const ACTIVITY_SEEDS = {
  obligation: [
    "ensaio vocal", "mix de faixa", "call com produtor", "entregar stem",
    "postar preview", "revisar letra", "gravar demo", "responder email"
  ],
  hobby: [
    "ouvir Machine Love", "tentar cover", "ver clipes", "jogar casual",
    "cozinhar pão", "organizar playlist", "estudar teoria musical"
  ],
  chore: [
    "lavar louça", "arrumar mesa", "trocar roupa de cama", "limpar microfone",
    "separar roupa", "pagar conta", "responder mensagens antigas"
  ],
  rest: ["cochilo curto", "deitar sem celular", "alongar", "tomar banho longo"],
  social: ["mandar meme pra Miku", "call com amigo", "responder fã", "comentar post"],
  creative: ["esboçar ideia de música", "escrever verso", "testar efeito vocal", "fazer beat"],
  distraction: ["scroll", "ver tiktok", "ficar no twitter", "ver anime"],
  selfCare: ["beber água", "comer direito", "sair pra ar", "meditar 5min"]
};

function parseLlmItems(raw) {
  const text = String(raw ?? "").trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class CreativeRoutineGenerator {
  constructor(lifeStateStore, lifeProfile, { bus = null, journalAppend = null, workerLlm = null } = {}) {
    this.store = lifeStateStore;
    this.profile = lifeProfile;
    this.bus = bus;
    this.journalAppend = journalAppend;
    this.workerLlm = workerLlm;
    this._lastLlmDayKey = null;
  }

  generateItem(type, phase, seed, labelOverride = null) {
    const pool = [
      ...(ACTIVITY_SEEDS[type] ?? []),
      ...(this.profile.seedsForPhase(phase) ?? [])
    ];
    const label = labelOverride ?? pick(seed, pool) ?? `${type}_${phase}`;
    return {
      id: `${type}_${Date.now()}_${seed % 1000}`,
      type,
      label,
      phase,
      status: "pending",
      createdAt: new Date().toISOString(),
      dueAt: null,
      priority: type === "obligation" ? 0.7 : 0.4
    };
  }

  applyItems(items, phase) {
    const state = this.store.get();
    state.obligations = [...(state.obligations ?? []), ...items.filter((i) => i.type === "obligation")].slice(-30);
    state.hobbies = [...(state.hobbies ?? []), ...items.filter((i) => i.type === "hobby")].slice(-20);
    state.chores = [...(state.chores ?? []), ...items.filter((i) => i.type === "chore")].slice(-15);
    this.store.patch(state);

    const journalEntry = {
      type: "routine_generated",
      phase,
      items: items.map((i) => ({ label: i.label, type: i.type })),
      ts: new Date().toISOString()
    };
    this.journalAppend?.(journalEntry);
    this.bus?.emit("life.routine_generated", journalEntry);
    return items;
  }

  generateDay({ phase = "manha", isWeekend = false } = {}) {
    const seed = contextualSeed([phase, isWeekend, new Date().toDateString()]);
    const items = [];

    const counts = {
      obligation: isWeekend ? 1 : 2,
      hobby: 2,
      chore: 1,
      creative: chance(seed, 0.6) ? 1 : 0,
      selfCare: 1
    };

    for (const [type, count] of Object.entries(counts)) {
      for (let i = 0; i < count; i += 1) {
        items.push(this.generateItem(type, phase, seed + i));
      }
    }

    return this.applyItems(items, phase);
  }

  async generateDayLlm({ phase = "manha", isWeekend = false, snapshot = {} } = {}) {
    const dayKey = new Date().toISOString().slice(0, 10);
    if (this._lastLlmDayKey === dayKey) {
      return this.generateDay({ phase, isWeekend });
    }
    if (!this.workerLlm?.generate) {
      return this.generateDay({ phase, isWeekend });
    }
    try {
      const prompt = `Gere um plano de dia da Kasane Teto como JSON array (máx 8 itens). Cada item: {"type":"obligation|hobby|chore|creative|selfCare","label":"..."}. Fase: ${phase}, fim de semana: ${isWeekend}. Contexto: ${JSON.stringify({
        mood: snapshot.emotion?.mood,
        activity: snapshot.life?.currentActivity,
        music: snapshot.music?.nowPlaying
      })}. Só JSON, sem explicação.`;
      const raw = await this.workerLlm.generate(prompt);
      const parsed = parseLlmItems(raw);
      if (!parsed?.length) {
        return this.generateDay({ phase, isWeekend });
      }
      const seed = contextualSeed([phase, dayKey]);
      const items = parsed.slice(0, 8).map((row, i) =>
        this.generateItem(
          ["obligation", "hobby", "chore", "creative", "selfCare", "rest", "social"].includes(row.type)
            ? row.type
            : "hobby",
          phase,
          seed + i,
          String(row.label ?? "").slice(0, 80) || null
        )
      );
      this._lastLlmDayKey = dayKey;
      const result = this.applyItems(items, phase);
      this.journalAppend?.({ type: "routine_llm_generated", phase, source: "worker_llm", ts: new Date().toISOString() });
      return result;
    } catch {
      return this.generateDay({ phase, isWeekend });
    }
  }

  advanceObligation(id, status, meta = {}) {
    const state = this.store.get();
    const list = state.obligations ?? [];
    const item = list.find((o) => o.id === id);
    if (!item) return null;
    item.status = STATUSES.includes(status) ? status : "done";
    item.updatedAt = new Date().toISOString();
    if (meta.reason) item.reason = meta.reason;

    if (status === "failed" || status === "delayed") {
      this.bus?.emit("obligation.failed", { item });
      const cascade = this.generateItem("obligation", item.phase, contextualSeed([id, status]));
      cascade.status = "pending";
      cascade.reason = `cascade_from_${id}`;
      state.obligations.push(cascade);
    }

    this.store.patch({ obligations: list });
    this.journalAppend?.({ type: "obligation_update", item, ts: new Date().toISOString() });
    return item;
  }

  async tick({ phase = "manha", isWeekend = false, snapshot = {}, useLlm = false } = {}) {
    const state = this.store.get();
    const pending = (state.obligations ?? []).filter((o) => o.status === "pending");
    if (pending.length < 2) {
      if (useLlm && this.workerLlm?.generate && phase === "manha") {
        return this.generateDayLlm({ phase, isWeekend, snapshot });
      }
      return this.generateDay({ phase, isWeekend });
    }
    return pending;
  }
}
