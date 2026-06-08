import { readJson, writeJson } from "../../infra/utils/fileStore.js";

import { contextualSeed, chance, pick } from "../brain/rng.js";



const DEFAULT_STATE = {

  soloThoughts: [],

  horizons: [],

  privateThoughts: [],

  plantedInterests: [],

  researchNotes: [],

  lastSoloAt: null

};



const HORIZON_MS = {

  "1h": 60 * 60 * 1000,

  "1d": 24 * 60 * 60 * 1000,

  "3d": 3 * 24 * 60 * 60 * 1000,

  "7d": 7 * 24 * 60 * 60 * 1000,

  "14d": 14 * 24 * 60 * 60 * 1000,

  "21d": 21 * 24 * 60 * 60 * 1000,

  "90d": 90 * 24 * 60 * 60 * 1000

};



export class AutonomousEvolution {

  constructor(path, { bus = null, journalAppend = null, workerLlm = null, searchAdapter = null, worldContext = null } = {}) {

    this.path = path;

    this.bus = bus;

    this.journalAppend = journalAppend;

    this.workerLlm = workerLlm;

    this.searchAdapter = searchAdapter;

    this.worldContext = worldContext;

    this.data = readJson(path, DEFAULT_STATE) ?? structuredClone(DEFAULT_STATE);

    this.data.soloThoughts ??= [];

    this.data.horizons ??= [];

    this.data.privateThoughts ??= [];

    this.data.plantedInterests ??= [];

    this.data.researchNotes ??= [];

  }



  save() {

    writeJson(this.path, this.data);

  }



  plantInterest(topic, horizon = "7d", meta = {}) {

    const entry = {

      id: `interest_${Date.now()}`,

      topic: String(topic ?? "").slice(0, 120),

      horizon,

      plantedAt: new Date().toISOString(),

      dueAt: new Date(Date.now() + (HORIZON_MS[horizon] ?? HORIZON_MS["7d"])).toISOString(),

      status: "planted",

      ...meta

    };

    this.data.plantedInterests.push(entry);

    this.data.horizons.push({

      id: entry.id,

      type: "interest",

      dueAt: entry.dueAt,

      topic: entry.topic

    });

    this.save();

    return entry;

  }



  appendSoloThought(text, meta = {}) {

    const entry = {

      ts: new Date().toISOString(),

      text: String(text ?? "").slice(0, 600),

      generated: meta.generated ?? false,

      ...meta

    };

    this.data.soloThoughts.push(entry);

    if (this.data.soloThoughts.length > 150) {

      this.data.soloThoughts = this.data.soloThoughts.slice(-150);

    }

    this.data.lastSoloAt = entry.ts;

    this.save();

    this.journalAppend?.({ type: "solo_thought", ...entry });

    this.bus?.emit("autonomous.solo_thought", entry);

    return entry;

  }



  generateSoloThought(snapshot = {}) {

    const seed = contextualSeed([

      snapshot.emotion?.mood,

      snapshot.life?.currentActivity,

      this.data.soloThoughts.length

    ]);

    const templates = [

      "fico pensando se devo terminar aquele mix",

      "será que a Miku viu minha mensagem?",

      "quero ouvir Machine Love de novo mas já ouvi demais essa semana",

      "tenho uma ideia de cover mas não sei se vale a pena",

      "tô com uma saudade leve de conversar com alguém",

      "preciso comer algo antes de continuar",

      "vi um sticker engraçado e ainda tô rindo sozinha"

    ];

    const text = pick(seed, templates);

    return this.appendSoloThought(text, { generated: true, source: "deterministic_v1" });

  }



  async generateSoloThoughtLlm(snapshot = {}) {

    if (!this.workerLlm?.generate) {

      return this.generateSoloThought(snapshot);

    }

    try {

      const prompt = `Gere UM pensamento interno curto (1-2 frases) da Kasane Teto, não para enviar. Contexto: ${JSON.stringify({

        mood: snapshot.emotion?.mood,

        activity: snapshot.life?.currentActivity,

        music: snapshot.music?.nowPlaying

      })}`;

      const text = await this.workerLlm.generate(prompt);

      return this.appendSoloThought(String(text ?? "").trim(), { generated: true, source: "worker_llm" });

    } catch {

      return this.generateSoloThought(snapshot);

    }

  }



  async performAutonomousResearch(topic, meta = {}) {

    if (!this.searchAdapter?.search || !topic) return null;

    try {

      const results = await this.searchAdapter.search(`Kasane Teto ${topic}`);

      const note = {

        ts: new Date().toISOString(),

        topic,

        results: (results ?? []).slice(0, 3).map((r) => ({ title: r.title, url: r.url })),

        ...meta

      };

      this.data.researchNotes.push(note);

      if (this.data.researchNotes.length > 80) {

        this.data.researchNotes = this.data.researchNotes.slice(-80);

      }

      this.save();

      this.journalAppend?.({ type: "autonomous_research", ...note });

      this.bus?.emit("autonomous.research", note);

      const summary = results?.[0]?.title

        ? `descobri algo sobre ${topic}: ${results[0].title}`

        : `pesquisei ${topic} mas não achei nada marcante`;

      this.data.privateThoughts.push({ ts: note.ts, text: summary, topic, source: "web_research" });

      return note;

    } catch {

      return null;

    }

  }



  async processDueHorizons(now = Date.now()) {

    const matured = [];

    for (const interest of [...this.data.plantedInterests]) {

      if (interest.status !== "planted") continue;

      if (Date.parse(interest.dueAt) <= now) {

        interest.status = "matured";

        matured.push(interest);

        const thought = this.appendSoloThought(

          `ainda penso em ${interest.topic} — talvez faça algo sobre isso`,

          { relatedInterest: interest.id, generated: true }

        );

        this.data.privateThoughts.push({

          ts: new Date().toISOString(),

          text: thought.text,

          interestId: interest.id

        });

        const topicLower = String(interest.topic ?? "").toLowerCase();

        const travelHint = /viagem|viajar|jap|tokyo|cultural|coreia|paris|londres|passeio/.test(topicLower);

        if (travelHint && this.worldContext?.planTripFromInterest) {

          const trip = this.worldContext.planTripFromInterest(interest.topic, {

            source: "matured_interest",

            interestId: interest.id

          });

          if (trip?.isTraveling) {

            this.appendSoloThought(

              `tô indo pra ${trip.locationLabel ?? trip.currentLocation} — ${interest.topic}`,

              { relatedInterest: interest.id, generated: true, source: "world_trip" }

            );

          }

        } else if (interest.topic && chance(contextualSeed([interest.id]), 0.55)) {

          await this.performAutonomousResearch(interest.topic, { interestId: interest.id });

        }

      }

    }

    if (matured.length) this.save();

    return matured;

  }



  getSnapshot() {

    return {

      soloThoughts: this.data.soloThoughts.slice(-5),

      privateThoughts: this.data.privateThoughts.slice(-3),

      plantedCount: this.data.plantedInterests.filter((i) => i.status === "planted").length,

      researchNotes: this.data.researchNotes.slice(-2)

    };

  }



  async tick(snapshot = {}, { useLlm = false } = {}) {

    const seed = contextualSeed([snapshot.life?.phase, snapshot.emotion?.mood]);

    const matured = await this.processDueHorizons();



    if (chance(seed, 0.15)) {

      if (useLlm && this.workerLlm?.generate) {

        await this.generateSoloThoughtLlm(snapshot);

      } else {

        this.generateSoloThought(snapshot);

      }

    }



    if (snapshot.media?.lastSticker && chance(seed + 1, 0.08)) {

      this.plantInterest("sticker que viu", "3d", { source: "media" });

    }



    if (snapshot.music?.pendingComment && chance(seed + 2, 0.12)) {

      await this.performAutonomousResearch("novo lançamento vocaloid", { source: "music" });

    }



    return {

      soloThoughts: this.data.soloThoughts.slice(-5),

      maturedInterests: matured,

      plantedCount: this.data.plantedInterests.filter((i) => i.status === "planted").length

    };

  }

}

